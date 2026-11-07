// Native-key extension of the existing desktop probes. The caller supplies its real OS IME
// and foreground/candidate-window checks; this module never synthesizes composition events.
import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function probeAluLearningIme({ page, key, candidateEvidence, shot, passed, wait,
  executionSubmissions, questionSubmissions }) {
  // The preceding native composition test intentionally edits the incomplete starter.
  // Enter a valid fixture through the real editor before testing a successful comparison.
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus(); await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(`// ALU #194 native input acceptance fixture\nmodule alu(input logic [3:0] A,B,input logic M,input logic [1:0] S,input logic Cin,output logic [3:0] F,output logic Cout); always_comb begin F=0; Cout=0; case({M,S}) 3'b000:F=~A; 3'b001:F=A&B; 3'b010:F=A|B; 3'b011:F=A^B; 3'b100:{Cout,F}={1'b0,A}+{1'b0,B}+Cin; default:begin F=0; Cout=0;end endcase end endmodule\n`);
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  const run = page.getByRole('button', { name: '运行', exact: true });
  await expect(run).toBeEnabled({ timeout: 120000 });
  await run.click();
  await expect(page.getByText(/已启用这次运行的作品/)).toBeVisible({ timeout: 120000 });
  await page.getByRole('button', { name: '新用例', exact: true }).click();
  const reason = page.getByLabel('选择这组输入的理由', { exact: true });
  await reason.fill(''); await reason.focus();
  const before = executionSubmissions().length;
  await key(page, [8, 14, 1, 4, 34]); // ceshi, physical keys in the caller's OS layout
  await wait(1300); const candidate = await candidateEvidence(page);
  shot('learning-ime-reason-candidate', candidate);
  await key(page, [49]); await wait(500);
  const committed = await reason.inputValue();
  assert.match(committed, /^[\u4e00-\u9fff]{2}$/, 'reason commits exactly one two-character native candidate');
  await key(page, [45, 34, 4, 0, 31]); // nihao
  await wait(1000); await candidateEvidence(page);
  await key(page, [53]); await wait(500);
  assert.equal(await reason.inputValue(), committed, 'reason Escape keeps the pre-composition text');

  // Request a tab change while the real popup is still open. The tool must retain focus until
  // the input method finishes; the original tab gesture then resumes without a manual refocus.
  await key(page, [45, 34, 4, 0, 31]); await wait(1000); await candidateEvidence(page);
  await page.getByRole('tab', { name: '作品', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: 'ALU 实验', exact: true }).getAttribute('aria-selected'), 'true');
  shot('learning-ime-reason-switch-held', await candidateEvidence(page));
  await key(page, [53]);
  await expect(page.getByRole('tab', { name: '作品', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click();
  assert.equal(await reason.inputValue(), committed, 'returning to the case restores the exact reason');
  assert.equal(executionSubmissions().length, before, 'reason composition, cancel and navigation never run a candidate');
  assert.equal(questionSubmissions().length, 0);
  passed('E1', 'new prediction reason accepts native Chinese, cancels without residue and survives active-composition navigation', { committed });

  await page.getByRole('button', { name: '运行并比较', exact: true }).click();
  await expect(page.getByRole('table', { name: '预测与实际比较' })).toBeVisible({ timeout: 120000 });
  await page.waitForFunction(() => {
    const actual = document.querySelector('[aria-label="预测与实际比较"] tbody tr td:nth-of-type(2)');
    return actual && /^[01xz]{4}$/i.test(actual.textContent.trim());
  }, undefined, { timeout: 120000 });
  const explanation = page.getByLabel('实验解释', { exact: true });
  await explanation.fill(''); await explanation.focus();
  await key(page, [8, 14, 1, 4, 34]); await wait(1300);
  shot('learning-ime-explanation-candidate', await candidateEvidence(page));
  await key(page, [49]); await wait(500);
  const text = await explanation.inputValue();
  assert.match(text, /^[\u4e00-\u9fff]{2}$/);
  await key(page, [45, 34, 4, 0, 31]); await wait(1000); await candidateEvidence(page);
  await key(page, [53]); await wait(500);
  assert.equal(await explanation.inputValue(), text, 'explanation Escape preserves the committed candidate');
  const afterRun = executionSubmissions().length;
  await page.getByRole('button', { name: '保存解释修订', exact: true }).click();
  await expect(page.getByText('解释修订 1', { exact: true })).toBeVisible();
  await wait(800);
  assert.equal(executionSubmissions().length, afterRun, 'explanation editing/saving does not execute an experiment');
  assert.equal(questionSubmissions().length, 0, 'native Chinese input and saving do not send a question');
  shot('learning-ime-explanation-saved');
  passed('E2', 'new explanation accepts/cancels native Chinese and saves an immutable revision without running or sending', { text });
}
