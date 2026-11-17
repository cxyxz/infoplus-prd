param(
  [Parameter(Mandatory=$true)][string]$InputDirectory,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [int]$Columns=3,
  [int]$Rows=4,
  [int]$ThumbnailWidth=300
)
Add-Type -AssemblyName System.Drawing
$source=(Resolve-Path -LiteralPath $InputDirectory).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$files=Get-ChildItem -LiteralPath $source -Filter 'page-*.png' -File | Sort-Object Name
$perSheet=$Columns*$Rows
for($start=0;$start -lt $files.Count;$start+=$perSheet){
  $group=@($files | Select-Object -Skip $start -First $perSheet)
  $sample=[System.Drawing.Image]::FromFile($group[0].FullName)
  try {
    $ratio=$sample.Height/$sample.Width
    $thumbHeight=[int]($ThumbnailWidth*$ratio)
    $gap=18
    $labelHeight=30
    $canvasWidth=$Columns*($ThumbnailWidth+$gap)+$gap
    $canvasHeight=$Rows*($thumbHeight+$labelHeight+$gap)+$gap
  } finally { $sample.Dispose() }
  $canvas=New-Object System.Drawing.Bitmap($canvasWidth,$canvasHeight)
  $graphics=[System.Drawing.Graphics]::FromImage($canvas)
  try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(235,238,241))
    $font=New-Object System.Drawing.Font('Microsoft YaHei',12)
    $brush=[System.Drawing.Brushes]::Black
    for($index=0;$index -lt $group.Count;$index++){
      $row=[math]::Floor($index/$Columns)
      $column=$index%$Columns
      $x=$gap+$column*($ThumbnailWidth+$gap)
      $y=$gap+$row*($thumbHeight+$labelHeight+$gap)
      $image=[System.Drawing.Image]::FromFile($group[$index].FullName)
      try {
        $graphics.DrawImage($image,$x,$y,$ThumbnailWidth,$thumbHeight)
        $graphics.DrawString($group[$index].BaseName,$font,$brush,$x,$y+$thumbHeight+4)
      } finally { $image.Dispose() }
    }
    $font.Dispose()
    $sheetNumber=[int][math]::Floor($start/$perSheet+1)
    $sheet=Join-Path $OutputDirectory ('sheet-{0:00}.jpg' -f $sheetNumber)
    $canvas.Save($sheet,[System.Drawing.Imaging.ImageFormat]::Jpeg)
    Write-Output $sheet
  } finally {
    $graphics.Dispose()
    $canvas.Dispose()
  }
}
