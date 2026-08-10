// 终端工具条上的按键：快捷键栏的字节序列，以及 tmux 基操菜单。
// key 即要发送的字节，onClick 时原样送进 pty——所以这里写的是 \x02 而不是「Ctrl-B」。


export const KEYS: [string, string][] = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ['^C', '\x03'], ['^D', '\x04'], ['Space', ' '], ['y', 'y'], ['n', 'n'], ['/', '/'], ['q', 'q'],
]

// tmux 基操菜单：前缀键 C-b(\x02) + 命令键，直接发给 tmux attach
// （key 即要发送的字节序列，onClick 时原样发出）
export const PFX = '\x02'
export const tmuxMenu = (t: (key: string) => string) => [
  { type: 'group', label: t('tmux.split'), children: [
    { key: PFX + '%', label: t('tmux.splitVertical') },
    { key: PFX + '"', label: t('tmux.splitHorizontal') },
  ]},
  { type: 'group', label: t('tmux.pane'), children: [
    { key: PFX + 'o', label: t('tmux.nextPane') },
    { key: PFX + '\x1b[A', label: t('tmux.selectPaneUp') },
    { key: PFX + '\x1b[B', label: t('tmux.selectPaneDown') },
    { key: PFX + '\x1b[D', label: t('tmux.selectPaneLeft') },
    { key: PFX + '\x1b[C', label: t('tmux.selectPaneRight') },
    { key: PFX + 'z', label: t('tmux.zoomPane') },
    { key: PFX + ' ', label: t('tmux.switchLayout') },
    { key: PFX + 'x', label: t('tmux.closePane'), danger: true },
  ]},
  { type: 'group', label: t('tmux.window'), children: [
    { key: PFX + 'c', label: t('tmux.newWindow') },
    { key: PFX + 'n', label: t('tmux.nextWindow') },
    { key: PFX + 'p', label: t('tmux.prevWindow') },
    { key: PFX + 'w', label: t('tmux.windowList') },
    { key: PFX + ',', label: t('tmux.renameWindow') },
  ]},
  { type: 'group', label: t('tmux.other'), children: [
    { key: PFX + '[', label: t('tmux.copyMode') },
    { key: PFX + 'd', label: t('tmux.detach') },
    { key: PFX + 't', label: t('tmux.clock') },
  ]},
] as const
