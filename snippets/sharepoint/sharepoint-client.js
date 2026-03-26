/**
 * SNIPPET: SharePoint / OneDrive File Client (Microsoft Graph API)
 * CATEGORY: Integration
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Fetches files from SharePoint / OneDrive via the Microsoft Graph API.
 *   Converts user-facing sharing URLs into Graph API download URLs using the
 *   Shares API, then downloads the file content as a Buffer.
 *
 *   Because DD Platform apps sit behind an AWS ALB with OIDC (EntraID), the
 *   access token from the `x-amzn-oidc-accesstoken` header already includes
 *   the `Files.Read.All` scope — no OBO (On-Behalf-Of) exchange is needed
 *   for basic file reads. Just forward that token to Graph.
 *
 * DEPENDENCIES:
 *   npm install axios
 *
 * ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
 *   The ALB OIDC access token is used directly — no extra secrets are
 *   required for basic SharePoint file access.
 *
 *   If you need Entra app credentials for advanced scenarios (e.g. app-only
 *   access, token exchange):
 *     APP_SECRET_3  ->  SECRET_3  ->  ENTRA_TENANT_ID  (Entra tenant ID)
 *     APP_SECRET_4  ->  SECRET_4  ->  ENTRA_CLIENT_ID  (Entra app client ID)
 *
 *   These will be injected automatically by the platform via SSM in the
 *   future. For now, map them from a spare secret slot (SECRET_3, etc.).
 *
 * USAGE:
 *   const {
 *     fetchFromSharePoint,
 *     convertShareLinkToGraphUrl,
 *     resolveGraphUrl,
 *   } = require('./sharepoint-client');
 *
 *   // In an Express route behind ALB OIDC:
 *   app.get('/api/sharepoint-file', async (req, res) => {
 *     const graphToken = req.headers['x-amzn-oidc-accesstoken'];
 *     const fileUrl = req.query.url; // SharePoint sharing URL or Graph URL
 *
 *     const buffer = await fetchFromSharePoint(graphToken, fileUrl);
 *     res.set('Content-Type', 'application/octet-stream');
 *     res.send(buffer);
 *   });
 *
 * FRONTEND TOKEN ACQUISITION (if ALB token doesn't work):
 *   If the ALB OIDC access token lacks the required scope, you can acquire
 *   a token on the frontend using @azure/msal-browser:
 *
 *     import { PublicClientApplication } from '@azure/msal-browser';
 *
 *     const msalConfig = {
 *       auth: {
 *         clientId: '<ENTRA_CLIENT_ID>',
 *         authority: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>',
 *       },
 *     };
 *     const pca = new PublicClientApplication(msalConfig);
 *     await pca.initialize();
 *
 *     // Try silent -> SSO -> popup (in that order)
 *     let tokenResponse;
 *     try {
 *       tokenResponse = await pca.acquireTokenSilent({
 *         scopes: ['Files.Read.All'],
 *       });
 *     } catch {
 *       try {
 *         tokenResponse = await pca.ssoSilent({
 *           scopes: ['Files.Read.All'],
 *         });
 *       } catch {
 *         tokenResponse = await pca.acquireTokenPopup({
 *           scopes: ['Files.Read.All'],
 *         });
 *       }
 *     }
 *     const graphToken = tokenResponse.accessToken;
 *     // Send this token to your backend in Authorization or a custom header
 */

const axios = require('axios');

// ---------------------------------------------------------------------------
// URL Conversion — SharePoint sharing URLs -> Graph API download URLs
// ---------------------------------------------------------------------------

/**
 * Converts a SharePoint / OneDrive sharing URL into a Graph API download URL.
 *
 * Uses the Microsoft Shares API encoding scheme:
 *   1. Base64-encode the sharing URL
 *   2. Strip trailing '=' padding
 *   3. Replace '/' with '_' and '+' with '-'
 *   4. Prefix with 'u!'
 *   5. Build the Graph /shares/{encoded}/driveItem/content URL
 *
 * @see https://learn.microsoft.com/en-us/graph/api/shares-get
 *
 * @param {string} sharingUrl — a SharePoint or OneDrive sharing URL
 * @returns {string} Graph API URL that downloads the file content
 */
function convertShareLinkToGraphUrl(sharingUrl) {
  const base64 = Buffer.from(sharingUrl, 'utf-8').toString('base64');
  const encoded = 'u!' + base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem/content`;
}

/**
 * Returns true if the URL is a SharePoint / OneDrive sharing link
 * (as opposed to a raw Graph API URL).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isShareLink(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('sharepoint.com/') && !url.startsWith('https://graph.microsoft.com');
}

/**
 * If the URL is a SharePoint sharing link, converts it to a Graph API URL.
 * Otherwise returns the URL unchanged (assumes it's already a Graph URL).
 *
 * @param {string} url — SharePoint sharing URL or Graph API URL
 * @returns {string} Graph API download URL
 */
function resolveGraphUrl(url) {
  return isShareLink(url) ? convertShareLinkToGraphUrl(url) : url;
}

// ---------------------------------------------------------------------------
// File Download
// ---------------------------------------------------------------------------

/**
 * Downloads a file from SharePoint / OneDrive via the Graph API.
 *
 * Accepts either a SharePoint sharing URL or a direct Graph API URL.
 * Returns the file content as a Buffer.
 *
 * In development mode (NODE_ENV=development), returns a mock buffer so you
 * can develop without a live Graph token.
 *
 * @param {string} graphToken — Microsoft Graph access token (Bearer)
 * @param {string} fileUrl   — SharePoint sharing URL or Graph API URL
 * @returns {Promise<Buffer>} file content
 * @throws {Error} with descriptive message for 401/403/404
 */
async function fetchFromSharePoint(graphToken, fileUrl) {
  // -------------------------------------------------------------------------
  // Development mock — return a placeholder so local dev works without auth
  // -------------------------------------------------------------------------
  if (process.env.NODE_ENV === 'development') {
    console.log('[SharePoint Mock] Would fetch:', fileUrl);
    return Buffer.from(`[Mock SharePoint file content for: ${fileUrl}]`);
  }

  if (!graphToken) {
    throw new Error(
      'Missing Graph API access token. Ensure the request passed through the ALB OIDC flow ' +
        'and the x-amzn-oidc-accesstoken header is present.'
    );
  }

  const downloadUrl = resolveGraphUrl(fileUrl);

  try {
    const response = await axios.get(downloadUrl, {
      headers: {
        Authorization: `Bearer ${graphToken}`,
      },
      responseType: 'arraybuffer',
      // Graph may return a 302 redirect to the actual blob storage URL.
      // axios follows redirects by default — this is the desired behavior.
      maxRedirects: 5,
    });

    return Buffer.from(response.data);
  } catch (error) {
    const status = error.response?.status;

    if (status === 401) {
      throw new Error(
        'SharePoint auth expired or token invalid (401). ' +
          'The ALB OIDC session may have expired — ask the user to reload the page.'
      );
    }
    if (status === 403) {
      throw new Error(
        'No access to this SharePoint file (403). ' +
          'The user may not have permission, or the Files.Read.All scope is missing from the token.'
      );
    }
    if (status === 404) {
      throw new Error(
        'SharePoint file not found (404). ' +
          'The sharing link may be broken or the file may have been deleted.'
      );
    }

    throw new Error(
      `SharePoint download failed (${status || 'network error'}): ${error.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  convertShareLinkToGraphUrl,
  isShareLink,
  resolveGraphUrl,
  fetchFromSharePoint,
};
