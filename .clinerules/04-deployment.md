# Deployment

## Steps

1. Ensure all required files exist:
   - `demo.config.yml` (with your name + email)
   - `frontend/Dockerfile`
   - `backend/Dockerfile`

2. Commit and push:
   ```bash
   git add .
   git commit -m "feat: my demo app"
   git push origin main
   ```

3. Wait ~5-10 minutes

4. Visit: `https://<demo-name>.demo.int.bayer.com`

## What Happens on Push

1. GitHub Actions triggers
2. Security scans run (CodeQL)
3. Docker images built
4. Images pushed to ECR
5. ECS service updated
6. Email notification sent

## If Deployment Fails

Check your email for details. Common issues:
- Security vulnerabilities detected
- Dockerfile syntax error
- Missing required files
- Invalid `demo.config.yml`

## Local Testing (Optional)

If you have Docker installed:

```bash
docker compose up --build
```

- Frontend: http://localhost:3000
- Backend: http://localhost:3001
