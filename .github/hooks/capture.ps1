$ErrorActionPreference = 'Stop'

function Get-Field($Object, [string[]]$Names) {
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($property -and $null -ne $property.Value) {
            return $property.Value
        }
    }
    return $null
}

function Get-UtcTimestamp($Value) {
    if ($Value -is [ValueType] -and $Value -isnot [string]) {
        $date = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$Value)
    } else {
        $date = [DateTimeOffset]::Parse([string]$Value).ToUniversalTime()
    }
    return $date.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

function Get-SelectedModel($Event, [string]$SessionId) {
    $model = Get-Field $Event @('model', 'model_name', 'modelName')
    if ($model) { return [string]$model }

    $storage = Join-Path $env:APPDATA 'Code\User\workspaceStorage'
    $sessionFile = Get-ChildItem -Path (Join-Path $storage "*\chatSessions\$SessionId.jsonl") -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($sessionFile) {
        try {
            $record = Get-Content -LiteralPath $sessionFile.FullName -TotalCount 1 | ConvertFrom-Json
            $selected = $record.v.inputState.selectedModel
            $metadata = $selected.metadata
            $name = [string](Get-Field $metadata @('name', 'family', 'id'))
            $tier = [string]$selected.modelConfiguration.tier
            $family = [string]$metadata.family
            if ($name) {
                $details = @()
                if ($tier) { $details += "tier=$tier" }
                if ($family -and $family -ne $name) { $details += "family=$family" }
                if ($details.Count) { return "$name ($($details -join '; '))" }
                return $name
            }
        } catch { }
    }
    return 'not exposed by hook or VS Code session state'
}

function Get-MessageText($Content) {
    if ($Content -is [string]) {
        return $Content
    }
    if ((Get-Field $Content @('type')) -eq 'text') {
        return [string](Get-Field $Content @('text', 'content'))
    }
    if ($Content -is [System.Collections.IEnumerable]) {
        $parts = foreach ($item in $Content) {
            if ($item -is [string]) {
                $item
            } elseif ((Get-Field $item @('type')) -eq 'text') {
                Get-Field $item @('text', 'content')
            }
        }
        return ($parts -join '')
    }
    return ''
}

function Find-AssistantMessages($Value, [System.Collections.Generic.List[string]]$Messages) {
    if ($null -eq $Value) { return }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string] -and $Value -isnot [System.Collections.IDictionary]) {
        foreach ($item in $Value) { Find-AssistantMessages $item $Messages }
        return
    }
    if ($Value -isnot [pscustomobject]) { return }

    $role = [string](Get-Field $Value @('role', 'speaker', 'type'))
    if ($role -match '^(assistant|ai)$') {
        $message = Get-Field $Value @('message')
        if ($null -eq $message) { $message = $Value }
        $stopReason = [string](Get-Field $message @('stop_reason', 'stopReason'))
        $toolCalls = Get-Field $message @('tool_calls', 'toolCalls')
        if ($stopReason -notmatch 'tool_use|tool_call' -and -not $toolCalls) {
            $text = Get-MessageText (Get-Field $message @('content', 'text'))
            if (-not [string]::IsNullOrWhiteSpace($text)) { $Messages.Add($text) }
        }
        return
    }
    foreach ($property in $Value.PSObject.Properties) {
        Find-AssistantMessages $property.Value $Messages
    }
}

function Get-FinalResponse($Event) {
    $direct = Get-Field $Event @('last_assistant_message', 'lastAssistantMessage', 'response')
    if ($direct -is [string] -and -not [string]::IsNullOrWhiteSpace($direct)) {
        return $direct
    }

    $transcriptPath = Get-Field $Event @('transcript_path', 'transcriptPath')
    if (-not $transcriptPath -or -not (Test-Path -LiteralPath $transcriptPath)) {
        throw 'Stop event did not provide a readable transcript_path.'
    }

    $transcript = Get-Content -LiteralPath $transcriptPath -Raw
    $messages = New-Object 'System.Collections.Generic.List[string]'
    try {
        Find-AssistantMessages ($transcript | ConvertFrom-Json) $messages
    } catch {
        foreach ($line in ($transcript -split '\r?\n')) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            try { Find-AssistantMessages ($line | ConvertFrom-Json) $messages } catch { }
        }
    }
    if ($messages.Count -eq 0) {
        throw 'No final assistant text found in the transcript; refusing to log tool or intermediate content.'
    }
    return $messages[$messages.Count - 1]
}

$event = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sessionId = [string](Get-Field $event @('session_id', 'sessionId'))
if (-not $sessionId) { throw 'Hook payload is missing session_id.' }

$cwd = [string](Get-Field $event @('cwd'))
if (-not $cwd) { $cwd = (Get-Location).Path }
$project = Split-Path -Leaf $cwd
$logDirectory = Join-Path $cwd '.agent-logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$eventName = [string](Get-Field $event @('hook_event_name', 'hookEventName'))
$timestamp = Get-UtcTimestamp (Get-Field $event @('timestamp'))
$model = Get-SelectedModel $event $sessionId
$logPath = Get-ChildItem -LiteralPath $logDirectory -Filter "*_$sessionId.md" -File | Select-Object -First 1 -ExpandProperty FullName

if ($eventName -eq 'UserPromptSubmit') {
    $prompt = Get-Field $event @('prompt')
    if ($null -eq $prompt) { throw 'UserPromptSubmit payload is missing prompt.' }
    if (-not $logPath) {
        $fileTimestamp = ([DateTimeOffset]::Parse($timestamp)).ToString('yyyy-MM-dd_HH-mm-ss')
        $logPath = Join-Path $logDirectory "${fileTimestamp}_${sessionId}.md"
        $author = (& git -C $cwd config user.name 2>$null | Select-Object -First 1)
        if (-not $author) { $author = 'unknown' }
        $header = @(
            '---'
            "session_id: $sessionId"
            "date: $(([DateTimeOffset]::Parse($timestamp)).ToString('yyyy-MM-dd'))"
            "author: $author"
            "model: $model"
            'tool: github-copilot-vscode'
            "project: $project"
            'total_exchanges: 0'
            "first_prompt_time: $timestamp"
            "last_prompt_time: $timestamp"
            '---'
            ''
            "# Session Log - $(([DateTimeOffset]::Parse($timestamp)).ToString('yyyy-MM-dd'))"
            ''
            "Session: ``$($sessionId.Substring(0, [Math]::Min(8, $sessionId.Length)))`` | Project: $project | Author: $author"
            ''
            '---'
            ''
        ) -join "`n"
        [IO.File]::WriteAllText($logPath, $header, (New-Object Text.UTF8Encoding($false)))
    }

    $existing = Get-Content -LiteralPath $logPath -Raw
    $number = ([regex]::Matches($existing, '\[LOG_ENTRY type=PROMPT')).Count + 1
    $entry = "[LOG_ENTRY type=PROMPT num=$number session=$sessionId]`ntimestamp: $timestamp`nmodel: $model`n`n$prompt`n`n`n"
    [IO.File]::AppendAllText($logPath, $entry, (New-Object Text.UTF8Encoding($false)))
    $updated = [IO.File]::ReadAllText($logPath)
    $updated = [regex]::Replace($updated, '(?m)^total_exchanges: .*$', "total_exchanges: $number", 1)
    $updated = [regex]::Replace($updated, '(?m)^last_prompt_time: .*$', "last_prompt_time: $timestamp", 1)
    [IO.File]::WriteAllText($logPath, $updated, (New-Object Text.UTF8Encoding($false)))
} elseif ($eventName -eq 'Stop') {
    if (-not $logPath) { throw 'No prompt log exists for this session.' }
    $response = Get-FinalResponse $event
    $existing = Get-Content -LiteralPath $logPath -Raw
    $number = ([regex]::Matches($existing, '\[LOG_ENTRY type=RESPONSE')).Count + 1
    $entry = "[LOG_ENTRY type=RESPONSE num=$number session=$sessionId]`ntimestamp: $timestamp`nmodel: $model`n`n$response`n`n"
    [IO.File]::AppendAllText($logPath, $entry, (New-Object Text.UTF8Encoding($false)))
} else {
    throw "Unsupported hook event: $eventName"
}