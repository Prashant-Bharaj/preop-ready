# 📁 File Handling Rules

## 🎯 Default: Process Files in Memory

**If storage isn't needed, don't store files.**

Most file operations (CSV import, PDF parsing, image conversion) don't need persistence.
Process in memory, return the result, let the file be garbage collected.

### ✅ Recommended: Memory Processing

```javascript
const multer = require('multer');
const csv = require('csv-parse/sync');

// Keep file in memory - don't save
const upload = multer({ storage: multer.memoryStorage() });

// NOTE: Route is '/import-csv', NOT '/api/import-csv'
// The /api prefix is added by frontend calls and stripped by Traefik/nginx
app.post('/import-csv', upload.single('file'), (req, res) => {
  const content = req.file.buffer.toString('utf-8');
  const records = csv.parse(content, { columns: true });
  
  // Return parsed data - file is not stored, automatically cleaned up
  res.json({ data: records, count: records.length });
});
// Frontend calls: fetch('/api/import-csv', ...) → Backend receives: /import-csv
```

### Why Memory Over Storage?

| Benefit | Explanation |
|---------|-------------|
| **Simpler** | No file management, cleanup, or storage logic |
| **More secure** | No user files sitting on disk |
| **Less resources** | No disk space used |
| **Cleaner code** | Just process and return |

---

## 🎯 Decision Flow

```
User asks for file handling
         │
         ▼
    Does the APP ACTUALLY NEED to store files for later access?
         │
    ┌────┴────┐
    │         │
   No        Yes
    │         │
    ▼         ▼
Memory      EFS Storage
(default)   (/data folder)
```

### When to Use Memory (Most Cases)

| App Description | Use Memory |
|-----------------|------------|
| "Import CSV and show results" | ✅ Yes |
| "Parse PDF and extract text" | ✅ Yes |
| "Convert image format" | ✅ Yes |
| "Analyze uploaded data" | ✅ Yes |
| "Generate report from file" | ✅ Yes |

### When to Use Persistent Storage

| App Description | Use EFS Storage |
|-----------------|-----------------|
| "Document management system" | ✅ Yes |
| "File gallery/sharing" | ✅ Yes |
| "Upload files, access them later" | ✅ Yes |
| "Team file sharing portal" | ✅ Yes |

---

## 📋 Memory Processing Patterns

### Parse CSV

```javascript
// Frontend: fetch('/api/import-csv') → Backend receives: /import-csv
app.post('/import-csv', upload.single('file'), (req, res) => {
  const content = req.file.buffer.toString('utf-8');
  const records = csv.parse(content, { columns: true });
  res.json({ data: records, count: records.length });
});
```

### Parse PDF

```javascript
const pdfParse = require('pdf-parse');

// Frontend: fetch('/api/parse-pdf') → Backend receives: /parse-pdf
app.post('/parse-pdf', upload.single('file'), async (req, res) => {
  const pdfData = await pdfParse(req.file.buffer);
  res.json({ text: pdfData.text, pages: pdfData.numpages });
});
```

### Process Image

```javascript
const sharp = require('sharp');

// Frontend: fetch('/api/resize-image') → Backend receives: /resize-image
app.post('/resize-image', upload.single('image'), async (req, res) => {
  const resized = await sharp(req.file.buffer)
    .resize(200, 200)
    .toBuffer();
  
  res.json({ image: resized.toString('base64') });
});
```

### Generate and Download

```javascript
// Frontend: fetch('/api/export-csv') → Backend receives: /export-csv
app.get('/export-csv', async (req, res) => {
  const data = await getData();
  const csv = generateCSV(data);
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=export.csv');
  res.send(csv);
});
```

---

## 💾 Persistent Storage (When Actually Needed)

**The platform provides AWS EFS mounted at `/data` for persistent storage.**

Only use this when the app truly requires storing files for later access.

### EFS Storage Pattern

```javascript
const UPLOAD_DIR = '/data/uploads';  // EFS - persists across restarts

// Ensure directory exists
const fs = require('fs');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

// Upload - Frontend: fetch('/api/upload') → Backend receives: /upload
app.post('/upload', upload.single('file'), (req, res) => {
  res.json({ filename: req.file.filename });
});

// Download - Frontend: fetch('/api/files/xxx') → Backend receives: /files/xxx
app.get('/files/:filename', (req, res) => {
  const filepath = path.join(UPLOAD_DIR, req.params.filename);
  if (fs.existsSync(filepath)) {
    res.download(filepath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});
```

### ⚠️ Important: Use `/data` for Persistence!

```javascript
// ✅ Persists - uses EFS
const UPLOAD_DIR = '/data/uploads';

// ❌ Lost on restart - container filesystem
const UPLOAD_DIR = './uploads';
```

---

## 💬 How to Communicate

### When User Asks for File Upload

```
Do you need to store the files for later access, or just process them?

For things like importing CSV data or parsing PDFs, I recommend processing 
in memory - simpler and cleaner, no storage needed.

If you need to actually keep the files (like a document library), 
I can set up persistent storage.
```

### Suggest Memory When Storage Not Needed

```
Since you're just [parsing/importing/converting] the file, I'll process it 
in memory rather than storing it. The data gets extracted and returned, 
then the file is cleaned up automatically.

This keeps things simple - no file management needed!
```

---

## 🔧 Local Development

For local testing with persistent storage:

```yaml
services:
  backend:
    build: ./backend
    volumes:
      - ./local-data:/data  # Mount local folder as /data
    ports:
      - "3000:3000"
```

---

## ⏱️ Timeouts for Large File Uploads

The platform ALB has a **5-minute idle timeout**. For large file uploads (30MB+) or requests where the backend processes data before responding (document extraction, LLM calls), you MUST configure timeouts at every layer:

### nginx (frontend/nginx.conf or nginx.local.conf)
```nginx
location /api {
    proxy_pass http://backend:3000;
    proxy_read_timeout 300s;    # Wait up to 5 min for backend response
    proxy_send_timeout 300s;    # Wait up to 5 min to send request to backend
    client_max_body_size 50m;   # Allow uploads up to 50MB
}
```

### Express (Node.js backend)
```javascript
// Increase payload limit (default is 100kb)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Set server timeout for long-running requests
server.setTimeout(300000); // 5 minutes
```

### FastAPI (Python backend)
```python
# uvicorn handles timeouts via --timeout-keep-alive
# Run with: uvicorn main:app --timeout-keep-alive 300
```

**Timeout chain (all must be ≥ processing time):**
```
ALB (300s) → Traefik (no limit) → nginx (proxy_read_timeout) → backend (server timeout)
```

If any layer in the chain times out before the backend finishes, the user gets a **502 Bad Gateway** or **504 Gateway Timeout**.

---

## 🎯 Summary

| Need | Approach | Storage Location |
|------|----------|------------------|
| Process file, return result | **Memory** (default) | N/A |
| Store files for later | EFS | `/data/uploads` |
| Database data | EFS | `/data/mysql` or `/data/postgres` |
