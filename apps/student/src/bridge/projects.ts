import type { ProjectSeed } from './types'

/**
 * 课程工具包与项目作品的 mock 声明。
 *
 * 工具包按课程声明中心工具区的核心工具（docs/home-design.md Q3：所有课程共享一条运行栏，
 * 状态与操作由学科工具包声明）。数字逻辑沿用既有的设计 / 虚拟板 / 波形；程序设计课程的核心
 * 工具是多文件代码编辑器；其余课程保持「工具包接入中」占位，不用别门课的工具顶替。
 *
 * 作品正文是课程包级 mock：只用于展示编辑与草稿行为，不代表任何真实课程的活动内容，
 * 也不声称可编译或可运行。正式版的作品来自服务端确认内容，本机草稿单独存放。
 */

export type ToolkitKind = 'digital-logic' | 'code' | 'none'

export function toolkitOf(course: string): ToolkitKind {
  if (course === '数字逻辑与部件设计') return 'digital-logic'
  if (course === '程序设计基础') return 'code'
  return 'none'
}

const WORDFREQ_MAIN = `#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "textscope.h"

/* 入口：按第一个参数分派 stats / find / top，其余参数是输入文件与查询词。 */
int main(int argc, char *argv[]) {
    if (argc < 3) {
        fputs("usage: textscope <stats|find|top> <file> [word|N]\\n", stderr);
        return EXIT_FAILURE;
    }

    WordTable table = {0};
    if (!read_words(argv[2], &table)) {
        fprintf(stderr, "cannot read %s\\n", argv[2]);
        return EXIT_FAILURE;
    }

    if (strcmp(argv[1], "stats") == 0) {
        print_stats(&table);
    } else if (strcmp(argv[1], "find") == 0 && argc > 3) {
        printf("%u\\n", count_word(&table, argv[3]));
    } else if (strcmp(argv[1], "top") == 0 && argc > 3) {
        print_top(&table, (size_t)atoi(argv[3]));
    } else {
        fputs("unknown operation\\n", stderr);
        free_words(&table);
        return EXIT_FAILURE;
    }

    free_words(&table);
    return EXIT_SUCCESS;
}
`

const WORDFREQ_HEADER = `#ifndef TEXTSCOPE_H
#define TEXTSCOPE_H

#include <stddef.h>

/* 统计口径：以空白分隔切词，区分大小写，不去标点（见活动材料）。 */
#define MAX_WORD 64
#define MAX_WORDS 4096

typedef struct {
    char text[MAX_WORD];
    unsigned count;
} WordEntry;

typedef struct {
    WordEntry entries[MAX_WORDS];
    size_t length;
} WordTable;

int read_words(const char *path, WordTable *table);
unsigned count_word(const WordTable *table, const char *word);
void print_stats(const WordTable *table);
void print_top(const WordTable *table, size_t limit);
void free_words(WordTable *table);

#endif
`

const WORDFREQ_WORDS = `#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "textscope.h"

/* TODO: 次数相同时要按字典序升序，现在只按出现顺序输出。 */
static int by_count_desc(const void *a, const void *b) {
    const WordEntry *x = a;
    const WordEntry *y = b;
    if (x->count != y->count) return (x->count < y->count) ? 1 : -1;
    return strcmp(x->text, y->text);
}

int read_words(const char *path, WordTable *table) {
    FILE *in = fopen(path, "r");
    if (in == NULL) return 0;

    char word[MAX_WORD];
    while (fscanf(in, "%63s", word) == 1) {
        size_t slot = table->length;
        for (size_t i = 0; i < table->length; i++) {
            if (strcmp(table->entries[i].text, word) == 0) {
                table->entries[i].count++;
                slot = table->length;
                break;
            }
        }
        if (slot == table->length && table->length < MAX_WORDS) {
            strncpy(table->entries[table->length].text, word, MAX_WORD - 1);
            table->entries[table->length].count = 1;
            table->length++;
        }
    }

    fclose(in);
    return 1;
}

unsigned count_word(const WordTable *table, const char *word) {
    for (size_t i = 0; i < table->length; i++) {
        if (strcmp(table->entries[i].text, word) == 0) return table->entries[i].count;
    }
    return 0;
}

void print_stats(const WordTable *table) {
    for (size_t i = 0; i < table->length; i++) {
        printf("%s %u\\n", table->entries[i].text, table->entries[i].count);
    }
}

void print_top(const WordTable *table, size_t limit) {
    WordTable sorted = *table;
    qsort(sorted.entries, sorted.length, sizeof(WordEntry), by_count_desc);
    for (size_t i = 0; i < sorted.length && i < limit; i++) {
        printf("%s %u\\n", sorted.entries[i].text, sorted.entries[i].count);
    }
}

void free_words(WordTable *table) {
    table->length = 0;
}
`

const WORDFREQ_SAMPLE = `the quick brown fox jumps over the lazy dog
the dog barks and the fox runs away
a quick fox is a happy fox
`

const WORDFREQ_NOTES = `# 我自己的实现说明

## 已完成

- 读入文件并按空白切词，词频存在 \`WordTable\` 里。
- \`stats\` 与 \`top\` 都能输出，\`find\` 找不到词时输出 0 而不是报错。

## 还没做

- 同频次时按字典序升序：\`by_count_desc\` 里已经比较了 \`text\`，但 \`print_stats\`
  还是按出现顺序输出，没有排序。
- 长单词截断到 63 个字符，没有给出提示。

## 借助模型的部分

排序比较函数是模型给的，我核对过它的返回值方向：\`qsort\` 要求升序时返回负数，
所以次数多的要返回 1。这一处我改过一次才通过。
`

const LIBRARY_MAIN = `"""校园图书检索：命令行入口。"""

from catalog import Catalog, load_books


def main() -> None:
    catalog = Catalog(load_books("books.txt"))
    keyword = input("输入书名关键词：").strip()
    hits = catalog.search(keyword)
    if not hits:
        print("没有找到匹配的书目")
        return
    for book in hits:
        print(f"{book.title} · {book.author} · {book.shelf}")


if __name__ == "__main__":
    main()
`

const LIBRARY_CATALOG = `"""书目数据结构与检索。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Book:
    title: str
    author: str
    shelf: str


class Catalog:
    def __init__(self, books: list[Book]) -> None:
        self._books = books

    def search(self, keyword: str) -> list[Book]:
        # 区分大小写的子串匹配；书名与作者都参与检索
        return [b for b in self._books if keyword in b.title or keyword in b.author]


def load_books(path: str) -> list[Book]:
    rows = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            title, author, shelf = line.rstrip("\\n").split("\\t")
            rows.append(Book(title, author, shelf))
    return rows
`

const LEDGER_MAIN = `"""个人记账工具：记录、分类与月度汇总。"""

from collections import defaultdict


def summarize(records):
    totals = defaultdict(int)
    for category, amount in records:
        totals[category] += amount
    return dict(sorted(totals.items(), key=lambda kv: -kv[1]))
`

const LEDGER_REPORT = `"""汇总输出。"""


def render(totals):
    for category, amount in totals.items():
        print(f"{category}\\t{amount}")
`

function seed(
  taskId: string,
  confirmedRevision: number,
  access: ProjectSeed['access'],
  files: Array<[string, string]>,
): ProjectSeed {
  return {
    taskId,
    confirmedRevision,
    access,
    files: files.map(([path, text], index) => ({
      fileId: `${taskId}-f${index + 1}`,
      path,
      lifecycle: 'active' as const,
      confirmed: { text, version: 1 },
    })),
  }
}

/**
 * 三个程序设计任务的作品集合。`access` 与任务状态分别声明：作品可写性在正式版由
 * Attempt 与分配状态决定，任务卡上的「进行中 / 已完成」不直接等于作品只读。
 */
export const demoProjects: Record<string, ProjectSeed> = {
  wordfreq: seed('wordfreq', 3, { kind: 'editable' }, [
    ['main.c', WORDFREQ_MAIN],
    ['textscope.h', WORDFREQ_HEADER],
    ['words.c', WORDFREQ_WORDS],
    ['sample.txt', WORDFREQ_SAMPLE],
    ['说明.md', WORDFREQ_NOTES],
  ]),
  library: seed('library', 2, { kind: 'editable' }, [
    ['main.py', LIBRARY_MAIN],
    ['catalog.py', LIBRARY_CATALOG],
  ]),
  // 终态示例：作品已提交，只读；编辑与新建都不可用，界面给出具体原因。
  ledger: seed('ledger', 4, { kind: 'read-only', reason: '作品已提交，任务处于终态' }, [
    ['ledger.py', LEDGER_MAIN],
    ['report.py', LEDGER_REPORT],
  ]),
}
