# 📚 Code Snippet Library

## ⚠️ IMPORTANT: Check Snippets Before Writing Code

**When a user requests a feature, ALWAYS check the snippet library first!**

This saves tokens, ensures consistency, and uses pre-vetted code.

---

## 🔍 How to Use Snippets

### Step 1: Check the Index

When user asks for a feature, first read:
```
snippets/INDEX.md
```

Search for relevant snippets matching:
- The feature type (file upload, AI, parsing, etc.)
- The language/framework (JS, Python, React)

### Step 2: If Snippet Exists (✅ status)

1. Read the snippet file
2. Copy the relevant code
3. Adapt to user's project:
   - Update variable names
   - Adjust import paths
   - Add project-specific customizations
4. Tell user: "I used a pre-built snippet for [X]"

### Step 3: If Snippet is TODO (🔜 status)

The snippet is a placeholder. You can:
1. Implement the code yourself (follow the snippet's structure)
2. Optionally, ask if user wants you to complete the snippet

### Step 4: If No Snippet Exists

Implement from scratch, but consider:
- Could this be useful for future projects?
- Should you add it to the snippet library?

---

## 📋 Available Snippet Categories

| Category | Folder | Common Uses |
|----------|--------|-------------|
| **LLM/AI** | `snippets/llm/` | AI chat, completions, internal LLM |
| **File Handling** | `snippets/file-handling/` | Upload, download, file operations |
| **Parsing** | `snippets/parsing/` | CSV, Excel, PDF, JSON parsing |
| **Auth** | `snippets/auth/` | SSO, JWT, basic authentication |
| **UI Components** | `snippets/ui-components/` | React components for common UI |

---

## 🎯 Feature → Snippet Mapping

When user says... → Check this snippet:

| User Request | Snippet to Check |
|--------------|------------------|
| "Add AI chat" / "Use ChatGPT" | `llm/openai-client.js` or `llm/bayer-llm-client.js` |
| "Upload files" | `file-handling/upload-handler.js` + `ui-components/file-upload-form.jsx` |
| "Download/export data" | `file-handling/download-handler.js` |
| "Import CSV" | `parsing/csv-parser.js` |
| "Import Excel" | `parsing/excel-parser.js` |
| "Parse PDF" | `parsing/pdf-parser.js` |
| "Add login" | `auth/` folder |
| "Show data in table" | `ui-components/data-table.jsx` |

---

## 💬 How to Communicate

### When Using a Snippet

```
I'll use a pre-built snippet for [file uploads] - this follows best practices 
and saves us time. Let me adapt it to your project...
```

### When Snippet is TODO

```
We have a template for [Excel parsing] but it needs implementation. 
I'll build it out now following the template structure.
```

### When No Snippet Exists

```
I don't have a pre-built snippet for [this feature], so I'll implement it 
from scratch. This will be custom code for your project.
```

---

## 🔄 Updating Snippets

If you implement a TODO snippet or create useful reusable code:

1. **Update the snippet file** with working implementation
2. **Update `snippets/INDEX.md`** - change status from 🔜 to ✅
3. **Tell the user**: "I've also updated the snippet library so this can be reused"

---

## ⚠️ Important Notes

1. **Always check INDEX.md first** - don't re-implement existing code
2. **Snippets are templates** - adapt them to the user's specific needs
3. **TODO snippets need implementation** - they're just placeholders
4. **Keep snippets generic** - they should work across projects
5. **Document dependencies** - snippets should list required packages
