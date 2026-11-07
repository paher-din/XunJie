import { modelObservationSchema } from '@xunjie/contracts/model-connections';
import { teachingStudentQuestionSchema } from '@xunjie/contracts/teaching-agent';
import { operationId } from './identity.js';
import type { TeachingToolOutcome } from './tool-types.js';

/** Preserve the complete accepted answer inside the existing bounded observation transport. */
export function studentResponseObservations(outcome: TeachingToolOutcome) {
  const result = outcome.result;
  const response = teachingStudentQuestionSchema.shape.response.unwrap().parse(result.response);
  const questionId = teachingStudentQuestionSchema.shape.questionId.parse(result.questionId);
  const questionVersion = teachingStudentQuestionSchema.shape.version.parse(result.questionVersion);
  const waitVersion = teachingStudentQuestionSchema.shape.waitVersion.parse(result.waitVersion);
  const question = teachingStudentQuestionSchema.shape.question.parse(result.question);
  const source = teachingStudentQuestionSchema.shape.source.parse(result.source);
  const identity = { version: 1, responseId: response.requestId, questionId, questionVersion, waitVersion };
  const answer = response.answer.kind === 'choice' ? { ...response.answer, label: response.text } : response.answer;
  const complete = JSON.stringify({ kind: 'student-response', ...identity, question, source, answer });
  const observation = (suffix: string, text: string) => modelObservationSchema.parse({
    observationId: operationId('student-response:' + response.requestId + ':' + suffix), version: 1, source: 'caller', text,
  });
  if (modelObservationSchema.shape.text.safeParse(complete).success) return [observation('complete', complete)];

  // JSON escaping can expand a legal 4000-unit answer beyond one observation. Number
  // each field's complete Unicode parts instead of truncating text or splitting JSON.
  const fields: [string, string][] = [['question', question], ['source.label', source.label], ['source.detail', source.detail]];
  if (response.answer.kind === 'text') fields.push(['answer.text', response.answer.text]);
  if (response.answer.kind === 'choice') fields.push(['answer.optionId', response.answer.optionId], ['answer.label', response.text]);
  return fields.flatMap(([field, text]) => {
    const parts: string[] = [];
    let part = '';
    for (const character of text) {
      if (part.length + character.length > 700) { parts.push(part); part = ''; }
      part += character;
    }
    if (part) parts.push(part);
    return parts.map((text, index) => observation(field + ':' + (index + 1), JSON.stringify({
      kind: 'student-response-part', ...identity, answerKind: response.answer.kind,
      field, part: index + 1, totalParts: parts.length, text,
    })));
  });
}
