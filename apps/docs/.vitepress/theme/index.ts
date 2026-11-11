/// <reference types="vitepress/client" />

import "@fontsource/iosevka/latin-400.css";
import "@fontsource/iosevka/latin-400-italic.css";
import "@fontsource/iosevka/latin-500.css";
import "@fontsource/iosevka/latin-600.css";
import "@fontsource/iosevka/latin-700.css";
import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import { useData } from "vitepress";
import "./style.css";

export default {
  extends: DefaultTheme,
  Layout() {
    const { frontmatter } = useData();
    return h(DefaultTheme.Layout, null, {
      "doc-before": () => {
        const { version, updated } = frontmatter.value;
        const metadata = [version && `Version ${version}`, updated && `Updated ${updated}`]
          .filter(Boolean)
          .join(" · ");
        return metadata
          ? h("p", { style: "color: var(--vp-c-text-2); font-size: 14px" }, metadata)
          : null;
      },
    });
  },
};
