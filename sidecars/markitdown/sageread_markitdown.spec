# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 单文件包：SageRead MarkItDown sidecar
# 构建：.venv/Scripts/python.exe -m PyInstaller sageread_markitdown.spec --noconfirm
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = [], [], []
for pkg in ("markitdown", "magika"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 巨型 ML 包（确定无 import 牵连）
        "torch",
        "torchaudio",
        "transformers",
        "matplotlib",
        "scipy",
        "sklearn",
        # 语音转写链路（speech_recognition/pydub 均为 transcribe_audio 函数体内惰性 import，
        # 源码实锤 _transcribe_audio.py:16-17；附件候选扩展名也不含音频，永不触达）
        # ——砍 43MB+ 把 exe 压进 GitHub 100MB 推送红线
        "speech_recognition",
        "speechrecognition",
        "pocketsphinx",
        "sphinxbase",
        "sounddevice",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="sageread_markitdown",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
