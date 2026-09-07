# Generates clearly labeled synthetic meeting audio for manual validation of
# Arabic and mixed Arabic/English transcription and action-plan summaries.
# Uses the Windows OneCore voices (Microsoft Naayf for Saudi Arabic, Microsoft
# Mark for English) through the WinRT speech API, then joins the segments with
# the FFmpeg binary bundled with the desktop app.
#
# Output: target/test-audio/TEST-DATA-arabic-meeting.wav (16 kHz mono) and .mp3
# plus TEST-DATA-arabic-meeting.script.txt with the spoken script and the
# expected extraction results.
param([ValidateSet('arabic','english')][string]$Set = 'arabic')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $repoRoot 'target/test-audio'
$segDir = Join-Path $outDir "segments-$Set"
New-Item -ItemType Directory -Force -Path $segDir | Out-Null
$ffmpeg = Join-Path $repoRoot 'frontend/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe'
if (-not (Test-Path $ffmpeg)) { throw "Bundled FFmpeg not found at $ffmpeg" }

[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime] | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
function Await-WinRt($operation, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$arabicVoice = $voices | Where-Object { $_.Language -like 'ar*' } | Select-Object -First 1
$englishVoice = $voices | Where-Object { $_.DisplayName -like '*Mark*' } | Select-Object -First 1
if (-not $englishVoice) { $englishVoice = $voices | Where-Object { $_.Language -like 'en*' } | Select-Object -First 1 }
if (-not $arabicVoice) { throw 'No Arabic OneCore voice is installed. Add the Arabic (Saudi Arabia) speech pack in Windows settings.' }
Write-Host "Arabic voice: $($arabicVoice.DisplayName) ($($arabicVoice.Language))"
Write-Host "English voice: $($englishVoice.DisplayName) ($($englishVoice.Language))"

# Each entry: language tag, speaker label (for the script file only), text.
$script = @(
    @('ar', 'Ahmed', 'هذا اجتماع تجريبي لاختبار تطبيق ميتلي، وليس اجتماعاً حقيقياً. اسمي أحمد وأنا مدير المشروع. معنا اليوم سارة وخالد.'),
    @('ar', 'Ahmed', 'الهدف من الاجتماع هو مراجعة إطلاق النسخة الجديدة من التطبيق ومتابعة المهام المعلقة.'),
    @('ar', 'Ahmed', 'سارة، هل انتهيت من تقرير الاختبار؟'),
    @('ar', 'Sara', 'نعم، أنهيت تقرير الاختبار أمس وأرسلته بالبريد الإلكتروني لكل الفريق.'),
    @('ar', 'Ahmed', 'ممتاز. قرارنا اليوم هو تأجيل الإطلاق إلى يوم الخميس القادم بسبب مشكلة في تسجيل الصوت.'),
    @('ar', 'Ahmed', 'خالد، من فضلك أصلح مشكلة تسجيل الصوت على ويندوز قبل يوم الثلاثاء.'),
    @('ar', 'Khalid', 'تمام، سأعمل عليها. لكنني ما زلت بانتظار موافقة قسم الأمن على الواجهة البرمجية الجديدة، وهذا يعطل عملي.'),
    @('en', 'Sara', 'Quick note in English. We still need to update the release notes and the pricing page before the launch.'),
    @('ar', 'Ahmed', 'أقترح أن نضيف ميزة الترجمة الفورية في النسخة القادمة، لكننا لم نتفق على ذلك بعد.'),
    @('ar', 'Ahmed', 'يجب أن يقوم أحد ما بتحديث صفحة التنزيل، ولم نحدد بعد من سيتولى ذلك.'),
    @('ar', 'Ahmed', 'شكراً للجميع، انتهى الاجتماع التجريبي.')
)

$englishScript = @(
    @('en', 'Ahmed', 'This is a test meeting to check the Minuteman application. It is not a real meeting. My name is Ahmed and I am the project manager. Sara and Khalid are with us today.'),
    @('en', 'Ahmed', 'The goal of this meeting is to review the launch of the new version of the application and follow up on pending tasks.'),
    @('en', 'Ahmed', 'Sara, did you finish the test report?'),
    @('en', 'Sara', 'Yes, I finished the test report yesterday and emailed it to the whole team.'),
    @('en', 'Ahmed', 'Excellent. Our decision today is to postpone the launch to next Thursday because of a problem with audio recording.'),
    @('en', 'Ahmed', 'Khalid, please fix the audio recording problem on Windows before Tuesday.'),
    @('en', 'Khalid', 'Okay, I will work on it. But I am still waiting for the security team to approve the new API, and that is blocking my work.'),
    @('ar', 'Sara', 'ملاحظة سريعة بالعربية: ما زلنا بحاجة إلى تحديث ملاحظات الإصدار وصفحة الأسعار قبل الإطلاق.'),
    @('en', 'Ahmed', 'I suggest we add live translation in the next version, but we have not agreed on that yet.'),
    @('en', 'Ahmed', 'Someone needs to update the download page. We have not decided yet who will do it.'),
    @('en', 'Ahmed', 'Thank you everyone, the test meeting is over.')
)
if ($Set -eq 'english') { $script = $englishScript }

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$index = 0
$segmentFiles = @()
foreach ($line in $script) {
    $index++
    $lang, $speaker, $text = $line
    $synth.Voice = if ($lang -eq 'ar') { $arabicVoice } else { $englishVoice }
    $stream = Await-WinRt ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
    $raw = Join-Path $segDir ('{0:D2}-{1}-{2}.wav' -f $index, $lang, $speaker)
    $file = [System.IO.File]::Create($raw)
    $netStream.CopyTo($file)
    $file.Dispose(); $netStream.Dispose(); $stream.Dispose()
    # Normalize every segment to 16 kHz mono and add a short pause after it.
    $norm = Join-Path $segDir ('{0:D2}-norm.wav' -f $index)
    & $ffmpeg -y -loglevel error -i $raw -af 'apad=pad_dur=0.8' -ar 16000 -ac 1 $norm
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg failed on $raw" }
    $segmentFiles += $norm
}

$listFile = Join-Path $segDir 'concat.txt'
($segmentFiles | ForEach-Object { "file '" + ($_ -replace '\\', '/') + "'" }) | Set-Content -Path $listFile -Encoding ascii
$wav = Join-Path $outDir "TEST-DATA-$Set-meeting.wav"
$mp3 = Join-Path $outDir "TEST-DATA-$Set-meeting.mp3"
& $ffmpeg -y -loglevel error -f concat -safe 0 -i $listFile -ar 16000 -ac 1 $wav
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg concat failed' }
& $ffmpeg -y -loglevel error -i $wav -codec:a libmp3lame -q:a 4 $mp3
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg mp3 export failed' }

$expected = @"
TEST DATA - synthetic meeting generated by scripts/generate-test-audio.ps1 (not a real meeting)

Spoken script:
"@
$index = 0
foreach ($line in $script) { $index++; $expected += "`n{0:D2} [{1}] {2}: {3}" -f $index, $line[0], $line[1], $line[2] }
$expected += @"


Expected extraction (same content in both sets; the english set has one Arabic sentence about release notes and the pricing page):
- Decision: launch postponed to next Thursday because of an audio recording problem.
- Completed task: Sara finished the test report yesterday and emailed it (checkbox must be checked).
- Assigned task with deadline: Khalid fixes the Windows audio recording problem before Tuesday.
- Unassigned tasks: update the release notes; update the pricing page; update the download page (owner Not specified).
- Blocker: Khalid is waiting for security-team approval of the new API.
- Suggestion, NOT a decision: add live translation in the next version.
- No calendar dates are spoken; relative deadlines ("before Tuesday", "next Thursday") must stay as spoken.
"@
Set-Content -Path (Join-Path $outDir "TEST-DATA-$Set-meeting.script.txt") -Value $expected -Encoding utf8
& $ffmpeg -loglevel error -i $wav -f null - 2>&1 | Out-Null
Write-Host "Wrote $wav and $mp3"
Get-Item $wav, $mp3 | ForEach-Object { '{0}  {1:N0} bytes' -f $_.Name, $_.Length }
