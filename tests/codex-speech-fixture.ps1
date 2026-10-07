# Generate local synthetic speech; no user recording or external audio is used.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$fixturePath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../work/codex-speech-test.wav'))
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $speaker.SetOutputToWaveFile($fixturePath)
  $speaker.Speak('Hello and welcome to Cutline. This is a local speech test for the video editor. Please add a title at the beginning of this video.')
} finally { $speaker.Dispose() }
Get-Item -LiteralPath $fixturePath | Select-Object FullName, Length
