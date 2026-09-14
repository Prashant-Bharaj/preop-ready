/// SNIPPET: User Identity Middleware (AWS ALB OIDC)
/// CATEGORY: Authentication
/// LANGUAGE: Rust (Actix-web)
/// STATUS: Ready
///
/// DESCRIPTION:
///   Extracts AND VERIFIES user identity from AWS ALB OIDC headers.
///   Works automatically in production (Azure AD via ALB).
///   Falls back to a test user for local development ONLY when the
///   ALLOW_LOCAL_DEV_IDENTITY=true opt-in is set (see below).
///
/// SECURITY MODEL:
///   The ALB overwrites x-amzn-oidc-* headers on every request, so a client
///   cannot inject identity through the front door. This middleware ALSO
///   cryptographically verifies the token (defense in depth): the JWT's
///   ES256 signature is checked against the ALB's regional public key
///   (fetched by key id, cached) and the expiry claim is enforced.
///   A present-but-invalid token is REJECTED — it never falls back to the
///   local dev user. Same bar as snippets/auth/user-identity.{js,py}.
///
///   `x-amzn-oidc-identity` is NEVER used as an identity source. It is a
///   plain header with no signature, so trusting it would be spoofable;
///   the subject comes from the verified JWT's `sub` claim only.
///
///   A MISSING header is also a rejection. The backend is reachable through
///   a second ingress path that carries no OIDC at all (API Gateway ->
///   VPC Link -> NLB -> the machine-to-machine ALB, which has no
///   authenticate-oidc action -> Traefik -> this backend). Treating "no
///   header" as "local developer" would hand that path a logged-in user.
///   The local-dev fallback therefore requires an explicit opt-in:
///
///     ALLOW_LOCAL_DEV_IDENTITY=true   # docker-compose / .env, local only
///
///   Production task definitions never set it, so a header-less request in
///   production yields None and the handler must answer 401.
///
///   The regional key endpoint serves the signing keys of EVERY load balancer
///   in the region, so a signature check alone accepts a token minted by any
///   other ALB. The platform therefore injects two pins into every deployed
///   task, checked against the JWT header:
///
///       PLATFORM_ALB_ARN      the platform ALB's ARN   -> header `signer`
///       ALB_EXPECTED_ISSUER   the Cognito pool issuer  -> header `iss`
///
///   Never hardcode either value or remove the checks. An unset pin falls
///   back to signature-only verification.
///
/// DEPENDENCIES (add to Cargo.toml):
///   serde = { version = "1", features = ["derive"] }
///   serde_json = "1"
///   base64 = "0.22"
///   actix-web = "4"
///   p256 = { version = "0.13", features = ["ecdsa", "pem"] }
///   reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
///
/// HEADERS AVAILABLE:
///   - x-amzn-oidc-data: JWT with user claims (sub, email, name) — VERIFIED
///   - x-amzn-oidc-identity: User's unique subject ID (informational only;
///     never trusted on its own)
///   - x-amzn-oidc-accesstoken: OIDC access token
///
/// USAGE:
///   use crate::middleware::user_identity::extract_user_identity;
///
///   async fn profile(req: HttpRequest) -> impl Responder {
///       let user = match extract_user_identity(&req).await {
///           Some(user) => user,
///           None => {
///               return HttpResponse::Unauthorized().json(serde_json::json!({
///                   "error": "UNAUTHORIZED",
///                   "message": "Identity token missing or could not be verified",
///                   "statusCode": 401
///               }))
///           }
///       };
///       HttpResponse::Ok().json(serde_json::json!({
///           "name": user.name, "email": user.email
///       }))
///   }
///
/// EXAMPLE:
///   // User object structure:
///   UserIdentity {
///       user_id: "MaTuw4CRnE7ZrlnsIntYUe83NiulIOEMYunPdOOHEAM",
///       email: Some("john.doe@bayer.com"),
///       name: Some("John Doe"),
///       given_name: Some("John"),
///       family_name: Some("Doe"),
///       is_local_dev: false,
///   }

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct UserIdentity {
    pub user_id: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub is_local_dev: bool,
}

/// ALB public keys, cached per key id. Keys rotate rarely; the cache lives for
/// the process lifetime and unknown kids trigger a fresh fetch.
fn key_cache() -> &'static Mutex<HashMap<String, VerifyingKey>> {
    static CACHE: OnceLock<Mutex<HashMap<String, VerifyingKey>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn b64url_decode(segment: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(segment)
        .ok()
}

/// Fetch (and cache) the ALB's public key for a given key id.
/// Endpoint per AWS docs: https://public-keys.auth.elb.<region>.amazonaws.com/<kid>
async fn alb_public_key(kid: &str, region: &str) -> Option<VerifyingKey> {
    // The kid lands in a URL path; keep it to the shape AWS actually issues so
    // a hostile header can never redirect the fetch somewhere else.
    if kid.is_empty()
        || !kid
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }

    if let Ok(cache) = key_cache().lock() {
        if let Some(key) = cache.get(kid) {
            return Some(*key);
        }
    }

    let url = format!("https://public-keys.auth.elb.{region}.amazonaws.com/{kid}");
    let pem = reqwest::get(&url)
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .await
        .ok()?;
    let key = VerifyingKey::from_public_key_pem(&pem).ok()?;

    if let Ok(mut cache) = key_cache().lock() {
        cache.insert(kid.to_string(), key);
    }
    Some(key)
}

/// Verify the ALB OIDC JWT: ES256 signature against the regional ALB public
/// key, plus expiry. Returns the verified claims, or None if invalid.
pub async fn verify_oidc_token(oidc_data: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = oidc_data.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    let header: serde_json::Value = serde_json::from_slice(&b64url_decode(parts[0])?).ok()?;
    let kid = header["kid"].as_str()?;
    // No region to fetch the key from -> cannot verify -> reject.
    // (Deployed ECS tasks always have AWS_REGION set.)
    let region = std::env::var("AWS_REGION")
        .or_else(|_| std::env::var("AWS_DEFAULT_REGION"))
        .ok()?;

    let key = alb_public_key(kid, &region).await?;
    // ALB signs with ES256; the JOSE signature is raw r||s (64 bytes)
    let signature = Signature::from_slice(&b64url_decode(parts[2])?).ok()?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    key.verify(signing_input.as_bytes(), &signature).ok()?;

    // Pin the signing load balancer and the identity provider behind it. Both
    // live in the JWT HEADER (`signer`, `iss`), not the payload. The regional
    // key endpoint serves keys for EVERY ALB in the region, so without these a
    // token minted elsewhere would verify.
    if !header_matches_env(&header, "signer", "PLATFORM_ALB_ARN")
        || !header_matches_env(&header, "iss", "ALB_EXPECTED_ISSUER")
    {
        return None;
    }

    let payload: serde_json::Value = serde_json::from_slice(&b64url_decode(parts[1])?).ok()?;
    if let Some(exp) = payload["exp"].as_i64() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_secs() as i64;
        if exp < now {
            return None;
        }
    }
    Some(payload)
}

/// True when the pin in `env_var` is unset/empty, or equals `header[field]`.
fn header_matches_env(header: &serde_json::Value, field: &str, env_var: &str) -> bool {
    match std::env::var(env_var) {
        Ok(expected) if !expected.is_empty() => header[field].as_str() == Some(expected.as_str()),
        _ => true,
    }
}

/// Extract user identity from AWS ALB OIDC headers (with verification).
///
/// Returns None when the OIDC token is missing or INVALID — the handler must
/// reject the request with 401 in that case.
pub async fn extract_user_identity(req: &actix_web::HttpRequest) -> Option<UserIdentity> {
    let oidc_data = req
        .headers()
        .get("x-amzn-oidc-data")
        .and_then(|v| v.to_str().ok());

    if let Some(data) = oidc_data {
        // Present but invalid -> reject, never fall back
        let payload = verify_oidc_token(data).await?;
        return Some(UserIdentity {
            user_id: payload["sub"].as_str()?.to_string(),
            email: payload["email"].as_str().map(String::from),
            name: payload["name"].as_str().map(String::from),
            given_name: payload["given_name"].as_str().map(String::from),
            family_name: payload["family_name"].as_str().map(String::from),
            is_local_dev: false,
        });
    }

    // No OIDC header at all. Only a machine that explicitly opted in gets the
    // local-dev user; everywhere else this is an unauthenticated request.
    if std::env::var("ALLOW_LOCAL_DEV_IDENTITY").as_deref() == Ok("true") {
        return Some(UserIdentity {
            user_id: "local-dev-user".to_string(),
            email: Some("dev@localhost".to_string()),
            name: Some("Local Developer".to_string()),
            given_name: Some("Local".to_string()),
            family_name: Some("Developer".to_string()),
            is_local_dev: true,
        });
    }

    eprintln!(
        "No x-amzn-oidc-data header — rejecting as unauthenticated. \
         For local development set ALLOW_LOCAL_DEV_IDENTITY=true (never in production)."
    );
    None
}

/// Get user display name with graceful fallback.
pub fn get_user_display_name(user: &UserIdentity) -> String {
    if let Some(ref name) = user.name {
        return name.clone();
    }
    if let (Some(ref given), Some(ref family)) = (&user.given_name, &user.family_name) {
        return format!("{} {}", given, family);
    }
    if let Some(ref email) = user.email {
        return email.split('@').next().unwrap_or("User").to_string();
    }
    "User".to_string()
}
