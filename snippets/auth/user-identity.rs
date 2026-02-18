/// SNIPPET: User Identity Middleware (AWS ALB OIDC)
/// CATEGORY: Authentication
/// LANGUAGE: Rust (Actix-web)
/// STATUS: Ready
///
/// DESCRIPTION:
///   Extracts user identity from AWS ALB OIDC headers.
///   Works automatically in production (Azure AD via ALB).
///   Falls back to test user for local development.
///
/// DEPENDENCIES (add to Cargo.toml):
///   serde = { version = "1", features = ["derive"] }
///   serde_json = "1"
///   base64 = "0.22"
///   actix-web = "4"
///
/// HEADERS AVAILABLE:
///   - x-amzn-oidc-data: JWT with user claims (sub, email, name)
///   - x-amzn-oidc-identity: User's unique subject ID
///   - x-amzn-oidc-accesstoken: OIDC access token
///
/// USAGE:
///   use crate::middleware::user_identity::{UserIdentity, extract_user_identity};
///
///   async fn profile(req: HttpRequest) -> impl Responder {
///       let user = extract_user_identity(&req);
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

use base64::Engine;
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

/// Extract user identity from AWS ALB OIDC headers.
pub fn extract_user_identity(req: &actix_web::HttpRequest) -> UserIdentity {
    let headers = req.headers();
    let oidc_data = headers.get("x-amzn-oidc-data").and_then(|v| v.to_str().ok());
    let oidc_identity = headers
        .get("x-amzn-oidc-identity")
        .and_then(|v| v.to_str().ok());

    // Try to decode the JWT from x-amzn-oidc-data header
    if let Some(data) = oidc_data {
        let parts: Vec<&str> = data.split('.').collect();
        if parts.len() >= 2 {
            if let Ok(decoded) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(parts[1])
            {
                if let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&decoded) {
                    return UserIdentity {
                        user_id: payload["sub"]
                            .as_str()
                            .map(String::from)
                            .or_else(|| oidc_identity.map(String::from))
                            .unwrap_or_default(),
                        email: payload["email"].as_str().map(String::from),
                        name: payload["name"].as_str().map(String::from),
                        given_name: payload["given_name"].as_str().map(String::from),
                        family_name: payload["family_name"].as_str().map(String::from),
                        is_local_dev: false,
                    };
                }
            }
        }
    }

    // Fallback: use identity header if JWT decode failed
    if let Some(identity) = oidc_identity {
        return UserIdentity {
            user_id: identity.to_string(),
            email: None,
            name: None,
            given_name: None,
            family_name: None,
            is_local_dev: false,
        };
    }

    // Fallback for local development (no ALB headers)
    UserIdentity {
        user_id: "local-dev-user".to_string(),
        email: Some("dev@localhost".to_string()),
        name: Some("Local Developer".to_string()),
        given_name: Some("Local".to_string()),
        family_name: Some("Developer".to_string()),
        is_local_dev: true,
    }
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
