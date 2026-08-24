$sh = New-Object -ComObject WScript.Shell
$links = @(
  'C:\Users\20995\Desktop\Better SageRead.lnk',
  'C:\Users\Public\Desktop\Better SageRead.lnk',
  'C:\Users\20995\Desktop\sageread.lnk',
  'C:\Users\20995\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Better SageRead.lnk'
)
foreach ($p in $links) {
  if (Test-Path $p) {
    $l = $sh.CreateShortcut($p)
    Write-Output ("{0}`n   => {1}  (工作目录: {2})" -f $p, $l.TargetPath, $l.WorkingDirectory)
  } else {
    Write-Output ("{0}`n   => (不存在)" -f $p)
  }
}
Write-Output '--- 安装目录 ---'
$candidates = @(
  'C:\Program Files\Better SageRead',
  'C:\Users\20995\AppData\Local\Programs\Better SageRead',
  'C:\Users\20995\AppData\Local\Better SageRead',
  'C:\Program Files (x86)\Better SageRead'
)
foreach ($c in $candidates) {
  if (Test-Path $c) {
    $exe = Join-Path $c 'better-sageread.exe'
    if (Test-Path $exe) {
      $ver = (Get-Item $exe).VersionInfo.ProductVersion
    } else {
      $ver = '(无 exe)'
    }
    Write-Output ("{0}  存在  版本: {1}" -f $c, $ver)
  }
}
Write-Output '--- 开始菜单 Better SageRead 文件夹 ---'
$smDir = 'C:\Users\20995\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Better SageRead'
if (Test-Path $smDir) { Get-ChildItem $smDir | ForEach-Object { Write-Output $_.Name } }
