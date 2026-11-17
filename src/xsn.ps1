param([Parameter(Mandatory)][string]$Directory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$settings = [System.Xml.XmlReaderSettings]::new()
$settings.DtdProcessing = 'Prohibit'
$settings.XmlResolver = $null
$settings.MaxCharactersInDocument = 20000000

function Read-Xml([string]$Path) {
    $reader = [System.Xml.XmlReader]::Create($Path, $settings)
    try {
        $xml = [System.Xml.XmlDocument]::new()
        $xml.XmlResolver = $null
        $xml.Load($reader)
        return ,$xml
    } finally { $reader.Dispose() }
}

$manifestPath = Join-Path $Directory 'manifest.xsf'
$manifest = Read-Xml $manifestPath
$xsf = 'http://schemas.microsoft.com/office/infopath/2003/solutionDefinition'
$manifestNs = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
$manifestNs.AddNamespace('xsf', $xsf)
$schemaNs = 'http://www.w3.org/2001/XMLSchema'
$bindingNs = 'http://schemas.microsoft.com/office/infopath/2003'
$xslNs = 'http://www.w3.org/1999/XSL/Transform'
$templatePath = Join-Path $Directory 'template.xml'
$defaults = @{}
if (Test-Path -LiteralPath $templatePath) {
    $template = Read-Xml $templatePath
    foreach ($element in $template.SelectNodes('//*[not(*)]')) {
        if ($element.InnerText -and -not $defaults.ContainsKey($element.LocalName)) {
            $defaults[$element.LocalName] = $element.InnerText
        }
    }
}
$fields = @(
    foreach ($file in Get-ChildItem -LiteralPath $Directory -File -Filter '*.xsd') {
        $schema = Read-Xml $file.FullName
        foreach ($element in $schema.GetElementsByTagName('element', $schemaNs)) {
            $name = $element.GetAttribute('name')
            $reference = $element.GetAttribute('ref')
            if (-not $name -and -not $reference) { continue }
            [ordered]@{
                name = $name
                ref = $reference
                type = $element.GetAttribute('type')
                restriction = @($element.GetElementsByTagName('restriction', $schemaNs) | ForEach-Object { $_.GetAttribute('base') })
                enumeration = @($element.GetElementsByTagName('enumeration', $schemaNs) | ForEach-Object { $_.GetAttribute('value') })
                minOccurs = $element.GetAttribute('minOccurs')
                maxOccurs = $element.GetAttribute('maxOccurs')
                parent = $element.SelectSingleNode('ancestor::*[local-name()="element"][1]').name
                defaultValue = $defaults[$name]
                file = $file.Name
            }
        }
    }
)
$index = 0
$views = @(
    foreach ($view in $manifest.SelectNodes('//xsf:views/xsf:view', $manifestNs)) {
        $index++
        $fileName = $view.SelectSingleNode('xsf:mainpane', $manifestNs).transform
        $viewData = [ordered]@{name = $view.GetAttribute('name'); file = $fileName; controls = @(); expressions = @(); html = $null; issue = $null}
        if (-not $fileName -or [IO.Path]::GetFileName($fileName) -ne $fileName) {
            $viewData.issue = 'Missing or unsupported transform path'
            $viewData
            continue
        }
        try {
            $path = Join-Path $Directory $fileName
            $stylesheet = Read-Xml $path
            $viewData.controls = @(
                foreach ($control in $stylesheet.SelectNodes('//*[@*]')) {
                    $binding = $control.GetAttribute('binding', $bindingNs)
                    if ($binding) {
                        [ordered]@{ binding = $binding; kind = $control.GetAttribute('xctname', $bindingNs); id = $control.GetAttribute('CtrlId', $bindingNs); title = $control.GetAttribute('title') }
                    }
                }
            )
            $viewData.expressions = @(
                foreach ($operation in $stylesheet.GetElementsByTagName('*', $xslNs)) {
                    foreach ($key in 'test','select','match') {
                        if ($operation.HasAttribute($key)) {
                            [ordered]@{ operation = $operation.LocalName; attribute = $key; expression = $operation.GetAttribute($key) }
                        }
                    }
                }
            )
            if (Test-Path -LiteralPath $templatePath) {
                $engine = [System.Xml.Xsl.XslCompiledTransform]::new()
                $engine.Load($stylesheet, [System.Xml.Xsl.XsltSettings]::Default, $null)
                $inputReader = [System.Xml.XmlReader]::Create($templatePath, $settings)
                $buffer = [IO.StringWriter]::new()
                $writer = [System.Xml.XmlWriter]::Create($buffer, $engine.OutputSettings)
                try {
                    $engine.Transform($inputReader, $null, $writer, $null)
                } finally {
                    $inputReader.Dispose()
                    $writer.Dispose()
                }
                $viewData.html = $buffer.ToString()
            }
        } catch {
            $viewData.issue = $_.Exception.Message
        }
        $viewData
    }
)
[ordered]@{
    fields = $fields
    views = $views
    rules = @($manifest.SelectNodes('//*[local-name()="ruleSet" or local-name()="customValidation"]') | ForEach-Object { $_.OuterXml })
} | ConvertTo-Json -Depth 12 -Compress
