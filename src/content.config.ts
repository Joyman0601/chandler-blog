import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.date(),
    updatedDate: z.date().optional(),
    tags: z.array(z.string()).default([]),
    series: z.string().optional(),
    seriesLabel: z.string().optional(),
    // 系列内的阅读顺序；不写的排在写了的后面，再按文件名
    seriesOrder: z.number().int().optional(),
  }),
});

export const collections = { blog };
