export const site = {
  url: "https://chandlerblog.com",
  title: "Chandler的博客",
  name: "Chandler",
  avatar: "/avatar.jpg",
  tagline: "做 Java 后端，顺手学点大模型 · 边学边记",
  description: "记录技术、项目和长期学习",
  bio: "一个折腾点技术的学生，在这里把学到的东西慢慢记下来。",
  seoDescription:
    "Chandler 的个人技术博客，记录 Java、Spring、AI 大模型应用开发、项目实践和长期学习。",
  keywords: ["Chandler", "技术博客", "Java", "Spring", "Spring Boot", "AI大模型应用", "RAG", "微服务"],
  focus: ["Java 后端", "Spring / 微服务", "AI 大模型应用"],
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
  // 项目卡片数据（首页「精选项目」取 featured，/projects 全部展示）
  projects: [
    {
      title: "企业知识库 RAG + Agent 助手",
      meta: "Java 17 / Spring Boot 3.3 / LLM / RAG / Tool Calling",
      summary:
        "基于 Spring Boot 实现的大模型应用后端项目，目标是把企业文档入库、向量检索、LLM 问答、工具调用、权限校验和生产治理串成一套可演示、可扩展的 Agent 后端框架。",
      details: [
        "文档链路：支持 txt / markdown 上传、chunk 切分、embedding、文档更新删除和 version/status 生命周期管理。",
        "问答链路：问题向量化后按权限与状态过滤 chunk，基于相似度召回上下文，并由后端生成可信 sources。",
        "Agent 链路：通过 ToolRegistry、ToolExecutionService 和受控 Agent Loop 管理工具调用、参数校验、高风险确认与审计日志。",
        "工程治理：包含 debug 检索、评估接口、成本耗时统计、错误码、安全自检和自动化测试。",
      ],
      href: "https://github.com/Joyman0601/RAG",
      featured: true,
    },
    {
      title: "从单体到微服务电商 demo",
      meta: "Spring Boot 3.2 / Spring Cloud Alibaba / Nacos / Seata / RabbitMQ",
      summary:
        "一套极简电商微服务学习项目，用 用户/订单/库存 三个服务加一个网关，把单体拆开后冒出来的问题逐个攻克，从注册发现一路跑到可观测性，每一步都有能跑起来的检查点和亲手验证过的实验现象。",
      details: [
        "服务治理：Nacos 注册发现与配置中心、Spring Cloud Gateway 网关统一鉴权、Feign 与 Dubbo 两种通信方式对比。",
        "稳定性：Sa-Token + Redis 分布式会话、Sentinel 限流与熔断降级、Seata AT 跨服务分布式事务。",
        "异步与可观测：RabbitMQ 事件驱动配套幂等与死信队列、Prometheus / Grafana / Zipkin 指标与链路追踪。",
        "工程沉淀：大量篇幅记录版本配套、Docker 镜像挂载、容器网络等真实环境踩坑与排查心法。",
      ],
      href: "https://github.com/Joyman0601/ms-learn",
      featured: true,
    },
    {
      title: "个人技术博客",
      meta: "Astro / Markdown / Cloudflare",
      summary:
        "当前正在维护的个人网站，用于发布技术文章、项目复盘和长期学习记录，已绑定 chandlerblog.com。",
      details: [
        "使用 Astro 生成静态页面，文章通过 Markdown 管理。",
        "通过 GitHub 和 Cloudflare 自动部署，支持自定义域名和基础 SEO。",
      ],
      href: "",
      featured: true,
    },
    {
      title: "后端工程实践笔记",
      meta: "Java / Spring / MyBatis / 部署",
      summary:
        "计划持续整理后端开发中的常见问题，包括接口设计、数据访问、异常处理、日志、测试和部署排查。",
      details: [
        "把零散问题沉淀为可复用的排查清单和实现记录。",
        "后续会从真实开发过程里逐步补充文章和示例。",
      ],
      href: "",
      featured: false,
    },
  ],
  // giscus 评论（基于 GitHub Discussions）。
  // category / categoryId 需在仓库开启 Discussions 后到 giscus.app 获取并填入；
  // 二者为空时评论区不渲染，不影响站点其它部分。
  giscus: {
    repo: "Joyman0601/chandler-blog",
    repoId: "R_kgDOSo_EFg",
    category: "Announcements",
    categoryId: "DIC_kwDOSo_EFs4C_AM8",
  },
};
