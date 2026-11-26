import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { AgentTool } from '@xunjie/agent-runtime';
import type { CourseMaterialContent, CourseRelease } from '@xunjie/contracts/courses';
import { teacherReleaseReferenceSchema } from '@xunjie/contracts/teacher-agent';
import { completed, errored, json } from '../capabilities/tool-support.js';

export interface TeacherPublishedCourse {
  find(query: string): Promise<{ taskId: string; releaseId: string; title: string; publishedAt: string }[]>;
  release(releaseId: string): Promise<CourseRelease>;
  material(releaseId: string, materialId: string): Promise<CourseMaterialContent>;
}

type Target = z.infer<typeof teacherReleaseReferenceSchema>;
const targetFields = teacherReleaseReferenceSchema.partial().shape;
const offset = z.number().int().nonnegative().default(0);
const length = z.number().int().min(1).max(800).default(800);
const taskInput = z.object({ ...targetFields, query: z.string().trim().min(1).max(200).optional(),
  offset, length, objectiveOffset: offset, helpNoteOffset: offset }).strict();
const listInput = z.object({ ...targetFields, offset, limit: z.number().int().min(1).max(3).default(3) }).strict();
const materialInput = z.object({ ...targetFields, materialId: z.uuid(), offset, length }).strict();

function textRange(text: string, offset: number, length: number, maxBytes = 4800) {
  const chars = Array.from(text);
  if (offset > chars.length) throw new StorageError('invalid');
  let end = offset, bytes = 0;
  while (end < chars.length && end < offset + length) {
    const size = Buffer.byteLength(JSON.stringify(chars[end]!)) - 2;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end++;
  }
  return { offset, length: end - offset, total: chars.length, nextOffset: end < chars.length ? end : null,
    text: chars.slice(offset, end).join('') };
}

export function createTeacherCourseTools(course: TeacherPublishedCourse, current?: Target): AgentTool[] {
  async function releaseOf(input: { taskId?: string | undefined; releaseId?: string | undefined }) {
    const target = teacherReleaseReferenceSchema.safeParse(input.taskId || input.releaseId
      ? { taskId: input.taskId, releaseId: input.releaseId } : current);
    if (!target.success) throw new StorageError('invalid');
    const release = await course.release(target.data.releaseId);
    if (release.taskId !== target.data.taskId) throw new StorageError('invalid');
    return release;
  }
  function tool<T extends z.ZodType>(name: string, description: string, schema: T, read: (input: z.output<T>) => Promise<object>): AgentTool {
    return { definition: { name, description, inputSchema: z.toJSONSchema(schema, { io: 'input',
      override({ jsonSchema }) { if (jsonSchema.format === 'uuid') delete jsonSchema.format; } }) },
      supportsBackground: false,
      async execute(call, context) {
        if (call.executionMode === 'background') return errored('仅支持前台读取。');
        try {
          await context.assertActive();
          const result = json(await read(schema.parse(call.input)));
          await context.assertActive();
          return completed(JSON.stringify(result), result);
        } catch (error) {
          if (error instanceof z.ZodError) return errored('工具参数无效。', { reason: 'invalid' });
          if (!(error instanceof StorageError)) throw error;
          return errored(error.code === 'invalid' ? '任务、发布版本或读取范围无效。' : '课程资料暂不可读取。', { reason: error.code });
        }
      } };
  }
  return [
    tool('read_course_task', '读取本课发布任务。传固定 taskId 和 releaseId 或使用页面上下文。用 query 查任务名，多版本时返回候选。offset 用于要求正文，objectiveOffset 用于目标，helpNoteOffset 用于帮助说明。', taskInput, async input => {
      if (input.query && (input.taskId || input.releaseId)) throw new StorageError('invalid');
      const matches = input.query ? await course.find(input.query) : undefined;
      if (matches && matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'missing',
        candidates: matches.slice(0, 3), more: matches.length > 3 };
      const release = await releaseOf(matches?.[0] ?? input);
      const { courseId, taskId, releaseId, contentDigest, taskTitle, helpPolicy } = release;
      const { note, ...rules } = helpPolicy;
      return { source: { kind: 'teacher-course-task', courseId, taskId, releaseId, version: contentDigest },
        taskTitle, helpPolicy: rules,
        ...(note !== undefined ? { helpNote: textRange(note, input.helpNoteOffset, input.length, 1000) } : {}),
        objectives: release.objectives.slice(input.objectiveOffset, input.objectiveOffset + 1),
        nextObjectiveOffset: input.objectiveOffset + 1 < release.objectives.length ? input.objectiveOffset + 1 : null,
        requirements: textRange(release.requirements, input.offset, input.length, 1400) };
    }),
    tool('list_design_materials', '列出指定发布版本公开材料的标题、类型及固定出处。使用 nextOffset 分页。', listInput, async input => {
      const release = await releaseOf(input);
      const source = { kind: 'teacher-course-task', courseId: release.courseId, taskId: release.taskId,
        releaseId: release.releaseId, version: release.contentDigest };
      const end = input.offset + input.limit;
      return { source, materials: release.materials.slice(input.offset, end), nextOffset: end < release.materials.length ? end : null };
    }),
    tool('read_design_material', '读取本课固定发布版本中的公开 UTF-8 文本段落。沿 nextOffset 续读。', materialInput, async input => {
      const release = await releaseOf(input);
      const entry = release.materials.find(item => item.materialId === input.materialId);
      if (!entry) throw new StorageError('missing');
      if (!/^text\//i.test(entry.mediaType) || entry.byteLength > 2 * 1024 * 1024)
        return { status: 'unsupported-format', materialId: entry.materialId, mediaType: entry.mediaType };
      const material = await course.material(release.releaseId, entry.materialId);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(material.contentBase64, 'base64')); }
      catch { return { status: 'unsupported-format', materialId: entry.materialId, mediaType: entry.mediaType }; }
      return { source: { kind: 'teacher-course-material', courseId: release.courseId, taskId: release.taskId,
        releaseId: release.releaseId, materialId: material.materialId, version: material.sha256 },
        title: material.title, ...textRange(text, input.offset, input.length) };
    }),
  ];
}
