from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1]
FONT_ROOT = ROOT / "packages/ui/src/assets/fonts"
SOURCE = FONT_ROOT / "lxgw-wenkai-regular.woff2"
OUTPUT = FONT_ROOT / "wenkai"
STYLESHEET = ROOT / "packages/ui/src/styles/fonts.css"
CORE_TEXT = (
    "首页循阶设置账户学生画像个性化模型关于学习对话我的课程活动学校个人"
    "看板继续学习上午好下午好晚上好中午好早上好今天想探讨什么"
    "本地学习空间数据与隐私项目仓库目标任务要求材料起始作品"
    "暂无信息添加供应商返回准备加载连接正在读取"
    "，。！？：；、（）“”‘’《》【】·—…"
)


def ranges(points):
    remaining = sorted(points)
    if not remaining:
        return ""
    result = []
    start = previous = remaining[0]
    for point in remaining[1:]:
        if point != previous + 1:
            result.append(f"U+{start:X}" if start == previous else f"U+{start:X}-{previous:X}")
            start = point
        previous = point
    result.append(f"U+{start:X}" if start == previous else f"U+{start:X}-{previous:X}")
    return ",".join(result)


def main():
    original = TTFont(SOURCE)
    original_cmap = original.getBestCmap()
    codepoints = set(original_cmap)
    core = codepoints & (set(range(0x20, 0x7F)) | set(map(ord, CORE_TEXT)))
    groups = {"core": core}
    for point in sorted(codepoints - core):
        page = point // 1024 * 1024
        groups.setdefault(f"u{page:04x}", set()).add(point)
    OUTPUT.mkdir(exist_ok=True)
    stylesheet = []
    covered = set()
    sizes = {}
    metrics = [("head", "unitsPerEm"), ("hhea", "ascent"), ("hhea", "descent"), ("hhea", "lineGap"),
               ("OS/2", "sTypoAscender"), ("OS/2", "sTypoDescender"), ("OS/2", "sTypoLineGap"),
               ("OS/2", "usWinAscent"), ("OS/2", "usWinDescent")]
    for name, points in groups.items():
        font = TTFont(SOURCE, recalcTimestamp=False)
        options = subset.Options()
        options.layout_features = ["*"]
        options.glyph_names = True
        options.notdef_outline = True
        options.recalc_timestamp = False
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=points)
        subsetter.subset(font)
        destination = OUTPUT / f"{name}.woff2"
        font.save(destination)
        generated = TTFont(destination)
        generated_cmap = generated.getBestCmap()
        assert set(generated_cmap) == points, name
        assert not covered.intersection(points), name
        covered.update(points)
        for table, attribute in metrics:
            assert getattr(generated[table], attribute) == getattr(original[table], attribute), (name, table, attribute)
        for point in points:
            assert generated["hmtx"][generated_cmap[point]] == original["hmtx"][original_cmap[point]], (name, point)
            assert generated["glyf"][generated_cmap[point]].getCoordinates(generated["glyf"]) == (
                original["glyf"][original_cmap[point]].getCoordinates(original["glyf"])
            ), (name, point, "outline")
        page = min(points) // 1024 * 1024
        unicode_range = points if name == "core" else set(range(page, page + 1024)) - core
        stylesheet.append(
            "@font-face {\n"
            "  font-family: 'LXGW WenKai';\n"
            f"  src: url('../assets/fonts/wenkai/{name}.woff2?no-inline') format('woff2');\n"
            "  font-weight: 400;\n"
            "  font-style: normal;\n"
            "  font-display: swap;\n"
            f"  unicode-range: {ranges(unicode_range)};\n"
            "}\n"
        )
        sizes[name] = destination.stat().st_size
    assert covered == codepoints
    for stale in OUTPUT.glob("*.woff2"):
        if stale.stem not in groups:
            stale.unlink()
    STYLESHEET.write_text("\n".join(stylesheet))
    print(f"Verified {len(codepoints)} codepoints, identical outlines, advances and vertical metrics across {len(groups)} subsets")
    print(f"Core: {sizes['core']} bytes; largest subset: {max(sizes.values())} bytes")


if __name__ == "__main__":
    main()
