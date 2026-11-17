param(
  [Parameter(Mandatory=$true)][string]$InputDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$Name='*.docx'
)
$renderSource=(Resolve-Path -LiteralPath $InputDirectory).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$renderTarget=(Resolve-Path -LiteralPath $OutputDirectory).Path
$word=New-Object -ComObject Word.Application
$word.Visible=$false
$word.DisplayAlerts=0
try {
  foreach($file in Get-ChildItem -LiteralPath $renderSource -Filter $Name -File) {
    if($file.Name -like '_*' -or $file.Name -like '*.pending.docx') { continue }
    $doc=$null
    try {
      $doc=$word.Documents.Open($file.FullName,$false,$true)
      $pdf=Join-Path $renderTarget ($file.BaseName+'.pdf')
      $doc.ExportAsFixedFormat($pdf,17)
      Write-Output ('EXPORTED '+$pdf+' PAGES '+$doc.ComputeStatistics(2))
    } finally { if($null -ne $doc){ $doc.Close($false) } }
  }
} finally { $word.Quit() }
