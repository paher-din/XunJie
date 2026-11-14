import type { StudentFactScope } from '@xunjie/contracts/student-facts';

export interface StudentFactCandidate { topic: string; statement: string; correction: boolean }
type ActivityView = { activityId: string; course?: { courseId: string } | null | undefined };

const PLACEHOLDER = /^(?:无|暂无|没有|略|空|待定|随便|都可以|都行|无所谓|看着办|n\/?a|none|null|-+|—+|\.{2,}|…+)$/iu;
const NON_STUDENT = /^(?:演示画像|示例画像|样例画像|busyinputmode|busyInputMode)/iu;
const QUESTION_START = /^(?:请问|为什么|怎么|如何|什么|哪|是否|能不能|可不可以|有没有|do\b|does\b|did\b|can\b|could\b|would\b|should\b|is\b|are\b|what\b|why\b|how\b|when\b|where\b|which\b|who\b)/iu;
const ZH_EXPLICIT = /(?:我(?:们)?(?:更|特别|非常|一直|通常|平时)?(?:喜欢|偏好|习惯|希望|想要|要求|需要)|我(?:们)?想(?!知道|了解|问)|我(?:以后|之后)|请(?:你)?(?:以后|之后|尽量|优先|用|把|按|给|帮|不要|别|记得|记住)|以后|之后|今后|未来|从现在(?:起|开始)|不要|不用|别再|别总|别老|别用|务必|一定|尽量|优先|记得|改成|改为|换成|不再|取消|收回|撤销)/u;
const EN_EXPLICIT = /(?:\bi(?:\s+really)?\s+(?:like|love|prefer|usually|always|never|want|hope|need|require)\b|\bi'?d\s+(?:like|prefer)\b|\bwe\s+(?:like|prefer|usually|always|never|want|hope|need|require)\b|\bplease\s+(?:always|never|use|don'?t|do not|from now on)\b|\bfrom now on\b|\bdon'?t\b|\bdo not\b|\bnever\b|\balways\b|\bprefer\b|\binstead\b|\bmake sure\b|\bremember to\b)/i;
const CORRECTION = /(?:不再|别再|别总|别老|别用|别把|别给|别问|别写|别做|别讲|别说|别催|别改|不要再用|不用再|改成|改为|换成|改掉|取消|收回|撤销)/u;
const COURSE_SCOPE = /(?:这门课|本课程|这个课程|该课程|这门课程)/u;
const GLOBAL_SCOPE = /(?:以后|之后|今后|未来|从现在|所有|一直|不论哪门课|不管哪门课|任何课程|所有课程|每门课|全部课程)/u;
export const CONTINUATION_TEXT = /(?:继续这个目标|继续这个主题|延续这个目标|延续这个主题|同一主题|same goal|same topic)/iu;

const TOPIC_MARKERS = /(?:我(?:们)?|本人|学生)?(?:更|特别|非常|一直|通常|平时)?(?:喜欢|偏好|习惯|希望|想要|要求|需要|想)|请(?:你)?|以后都?|之后都?|今后|未来|从现在(?:起|开始)|不要|不用|别再|别总|别老|别用|别把|别给|记住|不再|改成|改为|换成|改掉|取消|收回|撤销|务必|一定|尽量|优先|记得/gu;
const EN_TOPIC_MARKERS = /^(?:i(?:'?d| would)?\s+(?:really\s+)?(?:like|love|prefer|want|hope|need|require)|we\s+(?:really\s+)?(?:like|love|prefer|want|hope|need|require)|please|always|never|from now on|instead)\s+/iu;

/** Keyword buckets keep one stable topic across corrections of the same preference dimension. */
const TOPIC_CATEGORIES: readonly [string, RegExp][] = [
  ['解释语言', /中文|英文|英语|汉语|日文|日语|语言|chinese|english|language/iu],
  ['例子', /例子|举例|示例|案例|实例|example|instance/iu],
  ['格式', /格式|表格|列表|清单|要点|大纲|思维导图|代码块|标题|format|table|bullet|outline/iu],
  ['详略', /详细|简短|简洁|展开|概括|总结|步骤|一步一步|原理|深入|通俗|short|brief|concise|detailed|detail|steps?|principle/iu],
  ['节奏', /慢一点|快一点|节奏|速度|语速|pace|speed|slow|fast/iu],
  ['难度', /简单|基础|进阶|难度|difficult|beginner|advanced|easy/iu],
  ['互动', /提问|互动|讨论|对话|question|discussion|interactive/iu],
  ['练习', /作业|练习|习题|题目|practice|exercise|homework/iu],
  ['材料', /资料|材料|课本|教材|视频|文章|material|textbook|video|article/iu],
  ['时间', /时间|分钟|小时|每天|每周|日程|minute|hour|daily|weekly/iu],
  ['语气', /语气|严肃|幽默|轻松|亲切|tone|humou?r|friendly/iu],
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，,。.!！?？;；:：、"'“”‘’()（）【】\[\]{}<>《》]/gu, '');
}
function bigrams(value: string): Set<string> {
  const chars = [...value];
  if (chars.length < 2) return new Set(chars);
  const result = new Set<string>();
  for (let index = 0; index < chars.length - 1; index++) result.add(chars[index]! + chars[index + 1]!);
  return result;
}
function containment(left: string, right: string): number {
  const a = bigrams(left), b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared++;
  return shared / Math.min(a.size, b.size);
}
export function topicSimilarity(left: StudentFactCandidate | { topic: string; statement: string },
  right: { topic: string; statement: string }): number {
  const a = normalize(left.topic), b = normalize(right.topic);
  if (a && a === b) return 1;
  const topicScore = containment(a, b);
  const statementScore = containment(normalize(left.statement), normalize(right.statement));
  return Math.max(topicScore, statementScore * 0.9);
}
function isQuestion(sentence: string): boolean {
  const trimmed = sentence.trim();
  return /[?？]\s*$/u.test(trimmed) || QUESTION_START.test(trimmed) || /(?:吗|呢)\s*$/u.test(trimmed);
}

function splitSentences(text: string): string[] {
  return text.replace(/\r\n?/g, '\n')
    .split(/(?<=[。！？!?；;])|\n+|(?<=[.])\s+/u)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

function topicOf(value: string): string {
  const source = value.trim().replace(TOPIC_MARKERS, '').replace(EN_TOPIC_MARKERS, '')
    .replace(/^(?:please|always|never|from now on|instead)\s+/iu, '').replace(/^[，,、：:\s]+/u, '');
  for (const [topic, pattern] of TOPIC_CATEGORIES) if (pattern.test(value) || pattern.test(source)) return topic;
  const cleaned = source.replace(/[，,。.!！?？；;：:\s]+$/u, '').slice(0, 200);
  return cleaned || normalize(value).slice(0, 200);
}

/** A sentence with several explicitly marked clauses yields one fact per clause. */
function clausesOf(sentence: string): string[] {
  if (CORRECTION.test(sentence)) return [sentence];
  const parts = sentence.split(/[，,]/u).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return [sentence];
  const marked = parts.filter(part => (ZH_EXPLICIT.test(part) || EN_EXPLICIT.test(part))
    && !PLACEHOLDER.test(part) && !isQuestion(part));
  return marked.length >= 2 ? marked : [sentence];
}

/**
 * Conservative extraction: one explicit preference per sentence. Questions,
 * empty placeholders and non-student profile text never produce a fact.
 */
export function extractStudentFacts(text: string): StudentFactCandidate[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const facts: StudentFactCandidate[] = [];
  for (const sentence of splitSentences(text)) {
    for (const clause of clausesOf(sentence)) {
      const statement = clause.trim();
      if (statement.length < 2 || statement.length > 4000) continue;
      if (PLACEHOLDER.test(statement.replace(/[。.!！?？；;\s]+$/u, '')) || NON_STUDENT.test(statement)
        || isQuestion(statement)) continue;
      if (!ZH_EXPLICIT.test(statement) && !EN_EXPLICIT.test(statement)) continue;
      const correction = CORRECTION.test(statement);
      let topicSource = statement;
      if (correction) {
        const match = CORRECTION.exec(statement);
        if (match) {
          const before = statement.slice(0, match.index).replace(/^(?:我(?:们)?|本人|请(?:你)?|以后|之后|今后|从现在(?:起|开始))\s*/u, '')
            .replace(/^(?:更|特别|非常|一直|通常|平时)?(?:喜欢|偏好|习惯|希望|想要|要求|需要)\s*/u, '').trim();
          topicSource = before || statement.slice(match.index + match[0].length);
        }
      }
      const topic = topicOf(topicSource);
      if (!topic || topic.length < 2) continue;
      facts.push({ topic, statement, correction });
    }
  }
  return facts;
}

export function scopeOf(statement: string, activity: ActivityView): StudentFactScope {
  if (activity.course && COURSE_SCOPE.test(statement)) return { kind: 'course', courseId: activity.course.courseId };
  if (GLOBAL_SCOPE.test(statement)) return { kind: 'global' };
  return { kind: 'activity', activityId: activity.activityId };
}
