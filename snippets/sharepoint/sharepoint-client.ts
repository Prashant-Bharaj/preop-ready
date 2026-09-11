/**
 * scopes: [backend]
 * flags: [sharepoint]
 * description: SharePoint document library client (TypeScript) via Microsoft Graph API.
 */

/**
 * SharePoint / OneDrive File Client (TypeScript)
 *
 * Fetches files from SharePoint / OneDrive via the Microsoft Graph API.
 * Converts user-facing sharing URLs into Graph API download URLs using the
 * Shares API, then downloads the file content as a Buffer.
 *
 * Because DD Platform apps sit behind an AWS ALB with OIDC (EntraID), the
 * access token from the `x-amzn-oidc-accesstoken` header already includes
 * the `Files.Read.All` scope — no OBO exchange is needed for basic file reads.
 * Just forward that token to Graph.
 *
 * Dependencies:
 *   npm install axios
 *
 * Environment variables: none required for basic SharePoint file access
 * (the ALB OIDC access token is used directly).
 *
 * Usage:
 *   import { fetchFromSharePoint } from './sharepoint-client.js';
 *
 *   app.get('/sharepoint-file', async (req, res) => {
 *     const graphToken = req.headers['x-amzn-oidc-accesstoken'] as string;
 *     const buffer = await fetchFromSharePoint(graphToken, req.query.url as string);
 *     res.set('Content-Type', 'application/octet-stream');
 *     res.send(buffer);
 *   });
 */

import axios, { type AxiosError } from 'axios';

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
 */
export function convertShareLinkToGraphUrl(sharingUrl: string): string {
  const base64 = Buffer.from(sharingUrl, 'utf-8').toString('base64');
  const encoded =
    'u!' + base64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `https://graph.microsoft.com/v1.0/shares/${encoded}/driveItem/content`;
}

/**
 * Returns true if the URL is a SharePoint / OneDrive sharing link
 * (as opposed to a raw Graph API URL).
 */
export function isShareLink(url: unknown): url is string {
  if (!url || typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'sharepoint.com' || host.endsWith('.sharepoint.com');
}

/**
 * If the URL is a SharePoint sharing link, converts it to a Graph API URL.
 * Otherwise returns the URL unchanged (assumes it's already a Graph URL).
 */
export function resolveGraphUrl(url: string): string {
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
 * @throws {Error} with descriptive message for 401/403/404
 */
export async function fetchFromSharePoint(
  graphToken: string | undefined,
  fileUrl: string
): Promise<Buffer> {
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
    const response = await axios.get<ArrayBuffer>(downloadUrl, {
      headers: { Authorization: `Bearer ${graphToken}` },
      responseType: 'arraybuffer',
      maxRedirects: 5,
    });
    return Buffer.from(response.data);
  } catch (error) {
    const axiosErr = error as AxiosError;
    const status = axiosErr.response?.status;

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

    const message = axiosErr.message || String(error);
    throw new Error(
      `SharePoint download failed (${status || 'network error'}): ${message}`
    );
  }
}
