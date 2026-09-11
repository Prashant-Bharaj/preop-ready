import express from 'express';
import cors from 'cors';
import { registerRoutes } from './routes.js';
import { userIdentityMiddleware } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json());
app.use(userIdentityMiddleware);

// Health check endpoint for ECS
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy' });
});

registerRoutes(app);

// 4-arg error handler — Express detects error handlers by arity
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'InternalServerError', message: 'An unexpected error occurred', statusCode: 500 });
});

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => console.log(`backend listening on :${PORT}`));