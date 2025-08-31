import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export function activate(context: vscode.ExtensionContext) {
    console.log('VSCode Hitmarker extension is now active!');

    try {
        // Register command to toggle hitmarker
        const toggleCommand = vscode.commands.registerCommand('hitmarker.toggle', () => {
            try {
                const config = vscode.workspace.getConfiguration('hitmarker');
                const enabled = config.get('enabled', true);
                config.update('enabled', !enabled, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Hitmarker ${!enabled ? 'enabled' : 'disabled'}`);
            } catch (error) {
                console.error('Error toggling hitmarker:', error);
                vscode.window.showErrorMessage('Failed to toggle hitmarker');
            }
        });

        // Create hitmarker manager
        const hitmarkerManager = new HitmarkerManager(context);

        context.subscriptions.push(toggleCommand);
        context.subscriptions.push(hitmarkerManager);
        
        console.log('Hitmarker extension activated successfully');
    } catch (error) {
        console.error('Error activating hitmarker extension:', error);
        vscode.window.showErrorMessage(`Hitmarker extension failed to activate: ${error}`);
    }
}

class HitmarkerManager implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private audioPanel: vscode.WebviewPanel | undefined;
    private isAudioUnlocked: boolean = false;
    private hasPromptedUnlock: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        this.setupClickListener();
    }

    private setupClickListener() {
        // Listen for text editor selection changes (closest we can get to clicks)
        const onSelectionChange = vscode.window.onDidChangeTextEditorSelection((event) => {
            const config = vscode.workspace.getConfiguration('hitmarker');
            if (!config.get('enabled', true)) {
                return;
            }

            // Only trigger on manual selection changes (not programmatic)
            if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
                this.showHitmarker(event.textEditor, event.selections[0]);
            }
        });

        this.disposables.push(onSelectionChange);
    }

    private showHitmarker(editor: vscode.TextEditor, selection: vscode.Selection) {
        // Play sound
        this.playHitmarkerSound();

        // Temporarily change the cursor style instead of decorating text
        this.flashCursor(editor, 1000);

        // Show a crosshair overlay at the caret
        this.showCrosshairOverlay(editor);
    }

    private playHitmarkerSound() {
        try {
            const config = vscode.workspace.getConfiguration('hitmarker');
            if (!config.get('soundEnabled', true)) {
                return;
            }

            const mp3Path = this.context.asAbsolutePath(path.join('media', 'hitmarker.mp3'));
            if (!fs.existsSync(mp3Path)) {
                // No sound file present; nothing to do
                return;
            }

            const panel = this.ensureAudioPanel();
            // Reveal without focus so it's not disruptive
            panel.reveal(vscode.ViewColumn.Two, true);
            panel.webview.postMessage({ type: 'play' });

            if (!this.isAudioUnlocked && !this.hasPromptedUnlock) {
                this.hasPromptedUnlock = true;
                vscode.window.showInformationMessage(
                    'Hitmarker sound needs a one-time enable. Open the audio tab and click "Enable sound".',
                    'Open audio tab'
                ).then(choice => {
                    if (choice === 'Open audio tab') {
                        panel.reveal(vscode.ViewColumn.Two, false);
                    }
                });
            }
        } catch (error) {
            console.error('Error playing hitmarker sound:', error);
        }
    }

    private showCrosshairOverlay(editor: vscode.TextEditor) {
        try {
            const widthPx = 2; // adjust as needed
            const heightPx = 2; // adjust as needed
            const iconUri = vscode.Uri
                .file(this.context.asAbsolutePath(path.join('media', 'hitmarker.png')))
                .with({ query: String(Date.now()) }); // cache-bust so PNG changes take effect

            const crosshair = vscode.window.createTextEditorDecorationType({
                after: {
                    contentIconPath: iconUri,
                    width: `${widthPx}px`,
                    height: `${heightPx}px`,
                    margin: `0 0 0 -${Math.floor(widthPx / 2)}px`
                },
                overviewRulerColor: '#ff000080',
                overviewRulerLane: vscode.OverviewRulerLane.Center
            });

            const pos = editor.selection.start;
            const range = new vscode.Range(pos, pos);
            editor.setDecorations(crosshair, [{ range }]);

            setTimeout(() => crosshair.dispose(), 500);
        } catch (error) {
            console.error('Error showing crosshair overlay:', error);
        }
    }

    private ensureAudioPanel(): vscode.WebviewPanel {
        if (this.audioPanel) {
            return this.audioPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'hitmarkerAudio',
            'Hitmarker Audio',
            { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(this.context.asAbsolutePath('media'))]
            }
        );

        const mp3File = vscode.Uri.file(this.context.asAbsolutePath(path.join('media', 'hitmarker.mp3')));
        const mp3WebUri = panel.webview.asWebviewUri(mp3File);
        panel.webview.html = this.getAudioHtml(String(mp3WebUri));

        panel.webview.onDidReceiveMessage(msg => {
            if (!msg) { return; }
            if (msg.type === 'log') {
                console.log('[Hitmarker webview]', msg.message);
            } else if (msg.type === 'error') {
                console.error('[Hitmarker webview]', msg.message);
            } else if (msg.type === 'unlocked') {
                this.isAudioUnlocked = true;
                console.log('[Hitmarker] Audio unlocked by user gesture');
            }
        });

        panel.onDidDispose(() => {
            this.audioPanel = undefined;
        });

        this.audioPanel = panel;
        return panel;
    }

    private getAudioHtml(src: string): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Hitmarker Audio</title>
            <style>
                html,body{background:transparent;margin:0;padding:0;}
                #wrap{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}
                #unlock{pointer-events:auto;display:none;padding:6px 10px;border:1px solid #888;border-radius:6px;background:#1e1e1e;color:#fff;font-size:12px;}
                #unlock.show{display:inline-block;}
            </style>
        </head>
        <body>
            <audio id="sfx" preload="auto">
                <source src="${src}" type="audio/mpeg" />
            </audio>
            <div id="wrap"><button id="unlock" class="show">Enable sound</button></div>
            <script>
                const vscode = acquireVsCodeApi();
                const audio = document.getElementById('sfx');
                const unlockBtn = document.getElementById('unlock');
                let unlocked = false;

                try {
                    unlocked = localStorage.getItem('hitmarker_audio_unlocked') === '1';
                } catch {}

                function setUnlocked(v) {
                    unlocked = v;
                    try { localStorage.setItem('hitmarker_audio_unlocked', v ? '1' : '0'); } catch {}
                    unlockBtn.classList.toggle('show', !v);
                    if (v) { vscode.postMessage({ type: 'unlocked' }); }
                }

                async function playOnce() {
                    try { audio.currentTime = 0; await audio.play(); }
                    catch (e) { vscode.postMessage({ type: 'error', message: String(e && e.message || e) }); throw e; }
                }

                unlockBtn.addEventListener('click', async () => {
                    try { await playOnce(); setUnlocked(true); vscode.postMessage({ type: 'log', message: 'Audio unlocked' }); }
                    catch (e) { /* user gesture failed; leave button visible */ }
                });

                if (unlocked) { unlockBtn.classList.remove('show'); }

                window.addEventListener('message', async (event) => {
                    if (!event || !event.data) return;
                    const { type } = event.data;
                    if (type === 'play') {
                        if (unlocked) {
                            try { await playOnce(); } catch (e) {}
                        } else {
                            unlockBtn.classList.add('show');
                        }
                    }
                });
            </script>
        </body>
        </html>`;
    }

    private flashCursor(editor: vscode.TextEditor, durationMs: number = 1000) {
        try {
            const previous = editor.options.cursorStyle ?? vscode.TextEditorCursorStyle.Line;
            editor.options = { ...editor.options, cursorStyle: vscode.TextEditorCursorStyle.Block };
            setTimeout(() => {
                try {
                    editor.options = { ...editor.options, cursorStyle: previous };
                } catch {}
            }, durationMs);
        } catch (error) {
            console.error('Error flashing cursor:', error);
        }
    }

    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}

export function deactivate() {}
