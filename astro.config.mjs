import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  integrations: [react()],
  vite: {
    server: {
      allowedHosts: ['pdfeditor.imagize.in']
    }
  }
});