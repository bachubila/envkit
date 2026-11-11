import { defineConfig } from "vitepress";
import site from "../site.json";

export default defineConfig({
  title: site.title,
  description: site.description,
  srcDir: "content",
  sitemap: { hostname: site.hostname },
  lastUpdated: true,
  themeConfig: {
    nav: site.nav,
    sidebar: site.sidebar,
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/bachubila/envkit" }],
    editLink: {
      pattern: "https://github.com/bachubila/envkit/edit/main/apps/docs/content/:path",
    },
    footer: { message: "Released under the MIT License." },
  },
});
