import { defineConfig } from 'vite'
import { handleApi } from './server/og-api.ts'

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
  plugins: [
    {
      // Serve the OurGroceries proxy from the dev server so `npm run dev` is all you need.
      name: 'ourgroceries-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          handleApi(req, res).then((handled) => { if (!handled) next() }, next)
        })
      },
    },
  ],
})
