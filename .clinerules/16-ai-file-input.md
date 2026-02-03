# 📎 Giving Files to the AI

> **This guide covers how users can share files with the AI assistant for analysis.**
> This is DIFFERENT from "Application File Uploads" (see `14-file-handling.md`).

---

## 🎯 Two Different Scenarios

| Scenario | What It Means | Where Documented |
|----------|---------------|------------------|
| **AI File Input** | User gives AI a file to read/analyze | **This file** |
| **Application Uploads** | User's app handles file uploads | `14-file-handling.md` |

**Examples of AI File Input:**
- "Here's my requirements document, help me understand it"
- "I have an example Excel file, show me how to parse it"
- "Read this CSV and tell me what columns it has"
- "Look at this design mockup and build something similar"

---

## 📁 The `context/` Folder

**We use a `context/` folder for files you want the AI to read.**

```
my-project/
├── context/           ← Drop files here for AI to analyze
│   ├── requirements.docx
│   ├── example-data.xlsx
│   └── design-mockup.png
├── frontend/
├── backend/
└── ...
```

### Why `context/`?

| Benefit | Explanation |
|---------|-------------|
| **Gitignored** | Files are never committed - safe for sensitive data |
| **Organized** | Clear separation from your actual code |
| **Discoverable** | AI knows to look here when you mention files |
| **Clean** | Keeps temporary analysis files out of your project |

---

## 🚀 How to Give Files to the AI

### Method 1: Upload to `context/` Folder

**In Codespaces or VS Code:**
1. Right-click the `context/` folder in Explorer
2. Select "Upload..." or drag-and-drop files
3. Tell the AI: "Read context/my-file.xlsx"

**Or drag-and-drop:**
- Drag files from your desktop into the `context/` folder in the Explorer

### Method 2: Reference Any File

If the file is already somewhere in your project:
- Tell AI: "Read frontend/src/App.jsx"
- Or use `@` syntax: "@frontend/src/App.jsx"

### Method 3: Paste Content Directly

For small text files, just paste the content into the chat:
```
Here's my CSV:

name,email,department
John,john@example.com,Sales
Jane,jane@example.com,Engineering
```

---

## 📋 Supported File Types

### Works Great (Text-based)

| Type | Extensions | AI Can... |
|------|------------|-----------|
| Text | `.txt`, `.md` | Read directly, full content |
| Code | `.js`, `.py`, `.jsx`, `.ts`, etc. | Read and analyze |
| Data | `.csv`, `.json` | Read and parse structure |
| Config | `.yaml`, `.yml`, `.toml` | Read and understand |

### Also Supported (Binary)

| Type | Extensions | AI Can... |
|------|------------|-----------|
| Excel | `.xlsx`, `.xls` | Read content (converted to text) |
| PDF | `.pdf` | Extract and read text content |
| Images | `.png`, `.jpg`, `.gif`, `.webp` | View and describe |

> **Note:** Binary file reading depends on Cursor's capabilities. For complex Excel/PDF analysis, the AI might suggest building a parsing feature in your app.

---

## 💬 How to Ask the AI

### Good Examples

```
"I uploaded requirements.xlsx to the context folder - read it and 
summarize what features I need to build"

"Look at context/example-data.csv and show me how to parse it"

"Read @context/design-mockup.png and build a similar UI"

"I have an Excel file with customer data at context/customers.xlsx - 
help me create a database schema for it"
```

### AI Response Pattern

When a user mentions having a file:

1. **Check if file exists** - Read the file or ask where it is
2. **Acknowledge the content** - Summarize what you found
3. **Take action** - Help with what they asked

---

## ⚠️ Security Guidelines

### DO Upload to `context/`

- Example data files
- Requirements documents
- Design mockups
- Reference code
- Sample configurations

### DON'T Upload to `context/`

- API keys or credentials
- `.env` files with secrets
- Production database exports with real PII
- Private keys or certificates

> **The `context/` folder is gitignored**, so files won't be committed. But still be mindful of what you share - the AI conversation may be logged.

---

## 🔧 If `context/` Folder Doesn't Exist

Create it:

```bash
mkdir -p context
```

Or the AI can create it for you when needed.

The folder is gitignored by default in the template, so any files you put there stay local.

---

## 📊 Common Workflows

### "Help me understand this Excel file"

```
User: I have an Excel file with sales data, uploaded to context/sales.xlsx

AI: [Reads the file]
    I can see your Excel file has 3 sheets:
    - "Q1 Sales" with columns: Date, Product, Amount, Region
    - "Q2 Sales" with the same structure  
    - "Summary" with totals by region
    
    What would you like to do with this data?
```

### "Build something from this requirements doc"

```
User: Read context/requirements.pdf and build the app

AI: [Reads the file]
    I found these requirements:
    - User login system
    - Dashboard with charts
    - Export to CSV feature
    
    Let me start building this for you...
```

### "Parse data like this example"

```
User: Here's an example CSV in context/sample.csv - 
      I need to import files like this in my app

AI: [Reads the file]
    Your CSV has these columns: name, email, department
    
    I'll add a CSV import feature to your backend that handles 
    this format. Using memory processing so files aren't stored...
```

---

## 🎯 Summary

| Task | What to Do |
|------|------------|
| Give AI a file to read | Upload to `context/` folder, tell AI to read it |
| Reference existing file | Use `@path/to/file` or "read path/to/file" |
| Share small text content | Paste directly in chat |
| Keep files private | Use `context/` (gitignored) |
| Build file upload in app | See `14-file-handling.md` |
