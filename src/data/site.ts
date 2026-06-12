export const site = {
  url: "https://chandlerblog.com",
  title: "Chandler的博客",
  name: "Chandler",
  description: "记录技术、项目和长期学习",
  seoDescription:
    "Chandler的个人技术博客，记录 Java、Spring、AI 大模型应用开发、项目实践和长期学习。",
  keywords: ["Chandler", "技术博客", "Java", "Spring", "Spring Boot", "AI大模型应用", "RAG"],
  focus: ["Java", "Spring", "AI大模型应用"],
  nav: [
    { href: "/", label: "首页" },
    { href: "/blog/", label: "文章" },
    { href: "/tags/", label: "标签" },
    { href: "/projects/", label: "项目" },
    { href: "/about/", label: "关于" },
  ],
  links: [
    { label: "GitHub", href: "https://github.com/Joyman0601" },
    { label: "B站", href: "https://b23.tv/AXk25Qc" },
  ],
  // giscus 评论（基于 GitHub Discussions）。
  // category / categoryId 需在仓库开启 Discussions 后到 giscus.app 获取并填入；
  // 二者为空时评论区不渲染，不影响站点其它部分。
  giscus: {
    repo: "Joyman0601/chandler-blog",
    repoId: "R_kgDOSo_EFg",
    category: "",
    categoryId: "",
  },
};
