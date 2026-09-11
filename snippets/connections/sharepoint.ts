/**
 * scopes: [backend]
 * flags: [sharepoint]
 * description: SharePoint API client for document library access (TypeScript stub).
 */

/**
 * SharePoint API Access (TypeScript)
 *
 * Connect to SharePoint for reading lists, documents, and uploading files.
 *
 * Environment variables:
 *   SHAREPOINT_SITE_URL  — SharePoint site URL
 *   SHAREPOINT_CLIENT_ID — Azure AD app client ID
 *   SHAREPOINT_SECRET    — Azure AD app client secret
 *   SHAREPOINT_TENANT_ID — Azure AD tenant ID
 *
 * TODO: Replace this placeholder with your actual implementation.
 *
 * Example:
 *   import { getListItems, uploadFile } from './sharepoint.js';
 *   const items = await getListItems('MyList');
 *   await uploadFile('Documents', 'report.pdf', fileBuffer);
 */

export interface SharePointListItem {
  id: string;
  fields: Record<string, unknown>;
}

export interface GetListItemsOptions {
  top?: number;
}

export async function getListItems(
  _listName: string,
  _options: GetListItemsOptions = {}
): Promise<SharePointListItem[]> {
  throw new Error('SharePoint connection not configured — replace this placeholder');
}

export async function uploadFile(
  _libraryName: string,
  _fileName: string,
  _fileBuffer: Buffer
): Promise<{ url: string }> {
  throw new Error('SharePoint connection not configured — replace this placeholder');
}
