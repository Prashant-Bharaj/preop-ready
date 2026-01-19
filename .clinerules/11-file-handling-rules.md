# 📁 File Handling Rules

## ⚠️ Default: Process Files in Memory (Don't Store)

**This is the STRONG DEFAULT recommendation for hackathon projects.**

> **However**, if user EXPLICITLY requests file storage, explain the limitations 
> and implement it if they confirm they understand the trade-offs.

### ❌ DON'T Store Files

```javascript
// ❌ BAD - Don't save to disk
app.post('/upload', upload.single('file'), (req, res) => {
  // File saved to ./uploads/ - DON'T DO THIS
  res.json({ path: req.file.path });
});
```

### ✅ DO Process in Memory

```javascript
// ✅ GOOD - Process in memory, don't persist
app.post('/upload', upload.single('file'), (req, res) => {
  const buffer = req.file.buffer;  // File is in memory
  
  // Process the file
  const data = parseCSV(buffer);
  
  // Use the data
  // ...
  
  // File is automatically garbage collected
  res.json({ rows: data.length });
});
```

---

## 🤔 Why Not Store Files?

| Reason | Explanation |
|--------|-------------|
| **Ephemeral containers** | Files are LOST when container restarts |
| **No persistence** | Deployed containers don't have permanent storage |
| **Disk space** | Uploaded files fill up container storage |
| **Security** | Storing user files creates security risks |
| **Complexity** | Managing files adds unnecessary complexity |

---

## ✅ Correct Patterns

### Pattern 1: Process CSV/Excel and Return Data

```javascript
const multer = require('multer');
const csv = require('csv-parse/sync');

// Store in MEMORY, not disk
const upload = multer({ storage: multer.memoryStorage() });

app.post('/api/import-csv', upload.single('file'), (req, res) => {
  // File is in memory as buffer
  const content = req.file.buffer.toString('utf-8');
  
  // Parse the CSV
  const records = csv.parse(content, { columns: true });
  
  // Return the parsed data (or save to database)
  res.json({ data: records, count: records.length });
  
  // Buffer is automatically cleaned up
});
```

### Pattern 2: Process PDF and Extract Text

```javascript
const pdfParse = require('pdf-parse');

app.post('/api/parse-pdf', upload.single('file'), async (req, res) => {
  // Parse PDF from memory buffer
  const pdfData = await pdfParse(req.file.buffer);
  
  // Return extracted text
  res.json({ text: pdfData.text, pages: pdfData.numpages });
  
  // No file stored anywhere
});
```

### Pattern 3: Process Image and Return Result

```javascript
const sharp = require('sharp');

app.post('/api/resize-image', upload.single('image'), async (req, res) => {
  // Process image in memory
  const resized = await sharp(req.file.buffer)
    .resize(200, 200)
    .toBuffer();
  
  // Return as base64 or send directly
  res.json({ image: resized.toString('base64') });
});
```

### Pattern 4: Generate and Return (Don't Save)

```javascript
app.get('/api/export-csv', async (req, res) => {
  // Get data from database
  const data = await getData();
  
  // Generate CSV in memory
  const csv = generateCSV(data);
  
  // Send directly to user - don't save to disk
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=export.csv');
  res.send(csv);
});
```

---

## 🗄️ When User Explicitly Wants File Storage

**If user explicitly asks to save/store files, you CAN implement it!**

First, explain the trade-offs:
```
I can add file storage, but here are some things to know:

1. Files saved in the container will be LOST when the container restarts
2. For persistent storage, we have a few options:
   - Store in database (works, but limited to smaller files)
   - Store on disk (works locally, but lost on deploy restart)
   - Use cloud storage like S3 (more complex, but truly persistent)

Which approach would you like? For a hackathon demo, database storage 
usually works well for small files. What do you think?
```

### Option 1: Database Storage (Recommended for Hackathons)

```javascript
// Store file content in database as base64
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const fileData = {
    name: req.file.originalname,
    content: req.file.buffer.toString('base64'),
    mimetype: req.file.mimetype,
    size: req.file.size,
    uploadedAt: new Date()
  };
  
  const result = await db.query(
    'INSERT INTO files (name, content, mimetype, size) VALUES (?, ?, ?, ?)',
    [fileData.name, fileData.content, fileData.mimetype, fileData.size]
  );
  
  res.json({ id: result.insertId, name: fileData.name });
});

// Retrieve file
app.get('/api/files/:id', async (req, res) => {
  const file = await db.query('SELECT * FROM files WHERE id = ?', [req.params.id]);
  const buffer = Buffer.from(file.content, 'base64');
  
  res.setHeader('Content-Type', file.mimetype);
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
  res.send(buffer);
});
```

### Option 2: Disk Storage (With Caveats)

```javascript
const multer = require('multer');
const path = require('path');

// ⚠️ WARNING: Files will be lost on container restart!
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});

const upload = multer({ storage });

// Make sure uploads folder exists
const fs = require('fs');
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads', { recursive: true });
}
```

### Option 3: Cloud Storage (Advanced)

For truly persistent large file storage, recommend AWS S3 or similar.
This is more complex and usually overkill for hackathons.

---

## 🎯 Decision Flow

```
User asks for file handling
         │
         ▼
    Does the APP REQUIRE persistent files?
    (Based on description or explicit request)
         │
    ┌────┴────┐
    │         │
   No        Yes
    │         │
    ▼         ▼
Use memory   Implement storage
storage      (DB recommended)
(default)    
```

### When to Use Persistent Storage (Automatic)

**If the app description implies files need to persist, implement storage WITHOUT asking:**

| App Description | Implies Storage? | Action |
|-----------------|------------------|--------|
| "Import CSV and show results" | ❌ No | Memory - process and display |
| "Document management system" | ✅ Yes | Database storage |
| "Parse PDF and extract text" | ❌ No | Memory - process and return |
| "File gallery where users upload photos" | ✅ Yes | Database storage |
| "Upload Excel, save for later viewing" | ✅ Yes | Database storage |
| "Convert image format" | ❌ No | Memory - process and return |
| "Team file sharing portal" | ✅ Yes | Database storage |
| "Analyze uploaded data" | ❌ No | Memory - process and return |

### Keywords That Imply Persistent Storage

Watch for these in app descriptions:
- "save files", "store documents", "keep files"
- "view later", "access uploaded files", "file library"
- "document management", "file gallery", "file sharing"
- "download previously uploaded", "file history"
- "persistent", "permanent storage"

### Keywords That Imply Process-Only (Memory)

- "import", "parse", "analyze", "convert"
- "extract text", "process data"
- "one-time upload", "generate report from"

---

## 💬 How to Communicate This

### When User Asks for File Upload

```
I'll add file upload - the files will be processed in memory rather than 
saved to disk. This is the recommended approach because:

1. Container storage is temporary (files would be lost on restart)
2. It's more secure
3. It's simpler to maintain

The file data will be available for processing, we just won't store it permanently.
Is that okay, or do you specifically need to save files?
```

### When User Asks to Save Files

```
I'd recommend against saving files to the project folder because:

1. Deployed containers are ephemeral - files would be lost on restart
2. It fills up disk space
3. It creates security concerns

Instead, we can:
- Process files in memory and return the result
- Store small files in the database if you really need persistence
- Use cloud storage for large files (more complex)

For a hackathon, in-memory processing usually works great. What do you think?
```

---

## 📋 Multer Configuration

### ✅ Correct: Memory Storage

```javascript
const multer = require('multer');

// Use memory storage - files stay in RAM
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024  // 10MB max
  }
});

// req.file.buffer contains the file
```

### ❌ Wrong: Disk Storage

```javascript
// DON'T use disk storage
const upload = multer({
  dest: './uploads/'  // ❌ Files saved to disk
});
```

---

## 🎯 Summary

| Scenario | Approach |
|----------|----------|
| Import CSV/Excel | Parse in memory → return data or save to DB |
| Upload image | Process in memory → return result |
| Generate PDF/Excel | Generate in memory → send to user |
| User uploads document | Parse in memory → extract what's needed |
| Need to store files | Use database for small files, explain limitations |
