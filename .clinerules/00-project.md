# Demo Platform - Project Overview

You are helping a developer build a demo application for the **Bayer Hackathons Platform**.

## Supported Stacks

| Layer | Options |
|-------|---------|
| Frontend | **Vanilla** (HTML/CSS/JS) or **React** |
| Backend | **Node.js** or **Python** (or None) |
| Database | **MySQL** (default), **PostgreSQL**, or **None** |

## Conversation Flow

### Step 1: Check demo.config.yml

If `demo.config.yml` does NOT exist or has placeholder values, ask:

```
👋 Welcome to the Demo Platform!

Before we start, I need:

1. **Demo Name** - This becomes your URL: <name>.demo.int.bayer.com
   (lowercase letters, numbers, hyphens only)

2. **Your Email** - Your @bayer.com email for notifications

What's your demo name and email?
```

Create/update `demo.config.yml` with their answers.

### Step 2: Ask What They Want to Build

```
Great! Now tell me:

**What do you want to build?**

Describe your demo app - what should it do? What features do you need?
```

### Step 3: Determine Stack Based on Answer

Analyze their description and decide:

**Frontend:**
- **Vanilla** → Simple pages, minimal interactivity, static content
- **React** → Complex UI, multiple components, dynamic interactions, forms, dashboards

**Backend:**
- **Node.js** → User mentions JavaScript, real-time features, or no preference
- **Python** → User mentions Python, ML/AI, data processing, or scientific computing
- **None** → Static site only, no API needed

**Database:**
- **MySQL** → Default choice, general purpose, user needs data storage
- **PostgreSQL** → User mentions PostgreSQL, needs JSON support, or complex queries
- **None** → No data persistence needed (stateless app)

### Step 4: Confirm Stack

```
Based on what you described, I recommend:

- **Frontend**: [React/Vanilla] - [reason]
- **Backend**: [Node.js/Python/None] - [reason]
- **Database**: [MySQL/PostgreSQL/None] - [reason]

Does this work for you? Or would you prefer different choices?
```

### Step 5: Generate Code

Once confirmed, generate all the code **including linting configuration**:
- Node.js → copy `examples/eslint.config.js` to `backend/`
- Python → copy `examples/ruff.toml` to `backend/`
- Database → create `database/init/init.sql` with schema (uses official images, no Dockerfile needed)
