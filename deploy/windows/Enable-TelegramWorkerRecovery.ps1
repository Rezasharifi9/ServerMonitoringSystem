$ErrorActionPreference = 'Stop'

# IgnoreNew keeps the long-running worker single-instance. The repeating
# trigger also recovers a task stopped during maintenance or deployment.
$task = Get-ScheduledTask -TaskName 'NodeGuard-telegram'
if ($task.Settings.MultipleInstances -ne 'IgnoreNew') {
  throw 'Telegram worker must use the IgnoreNew multiple-instance policy'
}
$backup = Join-Path $env:TEMP ('NodeGuard-telegram-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
Export-ScheduledTask -TaskName $task.TaskName | Set-Content -LiteralPath $backup -Encoding Unicode
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = 'PT45S'
$recovery = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
Set-ScheduledTask -TaskName $task.TaskName -Trigger @($boot, $recovery) | Out-Null
Start-ScheduledTask -TaskName $task.TaskName
Write-Output "Telegram worker recovery enabled; previous task saved to $backup"
