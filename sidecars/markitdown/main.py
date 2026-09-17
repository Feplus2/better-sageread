# SageRead MarkItDown sidecar —— 一次性文件转 Markdown（LLM 友好）
# 用法: sageread_markitdown <input_file> --output <out.md>
# 协议: stdout 逐行 JSON（与 books_converter 同款行协议）：
#   {"type":"progress","stage":"detect|convert|write","message":"..."}
#   {"type":"done","ok":true,"output":"...","chars":12345,"engine":"markitdown","warnings":[...]}
#   {"type":"done","ok":false,"error":"..."}（进程退出码始终 0，成败看 JSON——Rust 侧好解析）
import argparse
import json
import os
import sys
import traceback


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="输入文件绝对路径")
    parser.add_argument("--output", required=True, help="输出 .md 绝对路径")
    args = parser.parse_args()

    src = os.path.abspath(args.input)
    dst = os.path.abspath(args.output)
    warnings: list[str] = []

    try:
        if not os.path.isfile(src):
            emit({"type": "done", "ok": False, "error": f"输入文件不存在: {src}"})
            return 0

        emit({"type": "progress", "stage": "detect", "message": "加载 MarkItDown"})
        try:
            from markitdown import MarkItDown
        except Exception as e:  # 依赖缺失属打包事故，明确报出
            emit({"type": "done", "ok": False, "error": f"MarkItDown 导入失败: {e}"})
            return 0

        emit({"type": "progress", "stage": "convert", "message": os.path.basename(src)})
        md = MarkItDown(enable_builtins=True, enable_plugins=False)
        result = md.convert(src)
        text = result.text_content or ""
        title = getattr(result, "title", None)
        if title:
            text = f"# {title}\n\n" + text

        # 空产出让上层能识别"扫描件/提取失败"特征（Phase C 分流依据）
        if not text.strip():
            warnings.append("empty-output")

        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)

        emit(
            {
                "type": "done",
                "ok": True,
                "output": dst,
                "chars": len(text),
                "engine": "markitdown",
                "warnings": warnings,
            }
        )
        return 0
    except Exception as e:
        emit({"type": "done", "ok": False, "error": f"{e}", "trace": traceback.format_exc()[-1500:]})
        return 0


if __name__ == "__main__":
    sys.exit(main())
