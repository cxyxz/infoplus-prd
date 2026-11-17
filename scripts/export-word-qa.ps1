param([Parameter(Mandatory=$true)][string]$Directory,[string]$Name='*.docx')
$taskRoot=(Resolve-Path -LiteralPath $Directory).Path
$taskWord=New-Object -ComObject Word.Application
$taskWord.Visible=$false
$taskWord.DisplayAlerts=0
try {
  foreach($taskFile in Get-ChildItem -LiteralPath $taskRoot -Filter $Name) {
    $taskDoc=$null
    try {
      $taskDoc=$taskWord.Documents.Open($taskFile.FullName,$false,$true)
      $taskPdf=Join-Path $taskRoot ($taskFile.BaseName+'.qa.pdf')
      $taskDoc.ExportAsFixedFormat($taskPdf,17)
      Write-Output $taskFile.Name
    } finally { if($null -ne $taskDoc){$taskDoc.Close($false)} }
  }
} finally {$taskWord.Quit()}
