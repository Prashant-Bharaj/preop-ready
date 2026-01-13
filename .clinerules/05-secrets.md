# 🔐 Step 5: Adding Secrets (API Keys, etc.)

## When Do They Need This?

Only explain secrets if they want to use:
- OpenAI / ChatGPT API
- External services with API keys
- Custom passwords or tokens

## Local Development (Quick Setup)

For testing locally, there's a ready-made template:

```
📁 backend/env.example  ← Copy this to create your local secrets
```

**Help them set it up:**
```
To use secrets locally, I'll help you set up the environment file:
```

**Then run for them:**
```bash
cp backend/env.example backend/.env
```

**Then say:**
```
Done! Now open backend/.env and fill in your actual API keys.
This file is private - it won't be uploaded to GitHub.
```

## How to Explain It Simply

```
To use OpenAI in your app, you'll need to add your API key securely.
Don't worry - I'll walk you through it!

**Step 1: Go to your GitHub repository**
(the website, not this code editor)

**Step 2: Click Settings** (top menu)

**Step 3: Click "Secrets and variables" → "Actions"** (left sidebar)

**Step 4: Click "New repository secret"**

**Step 5: Add your secret:**
- Name: APP_OPENAI_KEY
- Value: [paste your OpenAI API key]
- Click "Add secret"

**Step 6: Push your code again**
git push

That's it! Your app can now use OpenAI securely.
```

## Available Secret Names

Tell them which secrets are supported:

```
You can add these secrets (use exact names):

| Secret Name | What It's For |
|-------------|---------------|
| APP_OPENAI_KEY | OpenAI/ChatGPT API key |
| APP_API_KEY | Any generic API key |
| APP_API_SECRET | API secret/password |
| APP_DATABASE_URL | Custom database connection |
| APP_SECRET_1 | Custom secret #1 |
| APP_SECRET_2 | Custom secret #2 |
| APP_SECRET_3 | Custom secret #3 |
```

## Using Secrets in Code

In the backend code, access secrets like this:

```javascript
// The APP_ prefix is removed automatically!
const openaiKey = process.env.OPENAI_KEY;
const apiKey = process.env.API_KEY;
```

## Security Warning

If they try to put secrets in the code:

```
⚠️ Wait! Don't put your API key directly in the code.

If you do that, anyone who sees your code can steal it!
Instead, let's add it as a secret (I'll show you how).
```
