import type { TestProject } from 'vite-plus/test/node';
import { prepareTemplate } from './database.ts';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { template, dropTemplate } = await prepareTemplate();
  project.provide('testTemplate', template);
  return dropTemplate;
}
