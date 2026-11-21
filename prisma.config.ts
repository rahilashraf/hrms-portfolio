import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `prisma generate` needs no database, so builds (CI, Railway) run without DATABASE_URL.
// Migration commands require it and fail when it is unset.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
