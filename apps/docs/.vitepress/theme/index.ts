import { h } from "vue";
import DefaultTheme from "vitepress/theme";
import { useData } from "vitepress";

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
