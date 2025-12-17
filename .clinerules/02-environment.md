# Environment Variables

## Auto-Provided in Production

These are automatically available to your backend:

```
DATABASE_HOST
DATABASE_PORT
DATABASE_NAME
DATABASE_USER
DATABASE_PASSWORD
```

## Usage

```javascript
// Node.js
const host = process.env.DATABASE_HOST;
const port = process.env.DATABASE_PORT;
const db = process.env.DATABASE_NAME;
const user = process.env.DATABASE_USER;
const pass = process.env.DATABASE_PASSWORD;
```

```python
# Python
import os
host = os.environ.get('DATABASE_HOST')
port = os.environ.get('DATABASE_PORT')
db = os.environ.get('DATABASE_NAME')
user = os.environ.get('DATABASE_USER')
password = os.environ.get('DATABASE_PASSWORD')
```

## Database Connections

### Node.js + MySQL

```javascript
const mysql = require('mysql2/promise');

const connection = await mysql.createConnection({
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
});
```

### Node.js + PostgreSQL

```javascript
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
});
```

### Python + MySQL

```python
import mysql.connector

conn = mysql.connector.connect(
    host=os.environ['DATABASE_HOST'],
    port=os.environ['DATABASE_PORT'],
    database=os.environ['DATABASE_NAME'],
    user=os.environ['DATABASE_USER'],
    password=os.environ['DATABASE_PASSWORD'],
)
```

### Python + PostgreSQL

```python
import psycopg2

conn = psycopg2.connect(
    host=os.environ['DATABASE_HOST'],
    port=os.environ['DATABASE_PORT'],
    dbname=os.environ['DATABASE_NAME'],
    user=os.environ['DATABASE_USER'],
    password=os.environ['DATABASE_PASSWORD'],
)
```
