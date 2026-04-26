/**
 * Styles for the shadow-DOM portion of the widget.
 * Kept as a TS string so the build can tree-shake it into the bundle.
 */
export const widgetStyles = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, system-ui, sans-serif; }

.fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #2e7dd7;
  color: #fff;
  border: 0;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,0,0,0.22);
  z-index: 2147483647;
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 120ms ease;
}
.fab:hover { transform: scale(1.06); }
.fab.open { transform: rotate(45deg); }
.fab-icon { display:block; line-height: 1; }

.panel {
  position: fixed;
  right: 16px;
  bottom: 82px;
  width: 340px;
  max-height: 70vh;
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 8px;
  box-shadow: 0 10px 36px rgba(0,0,0,0.15);
  display: none;
  flex-direction: column;
  z-index: 2147483647;
  color: #1b1f23;
  overflow: hidden;
}
.panel.open { display: flex; }

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid #eaeef2;
}
.panel-header .title { font-weight: 600; font-size: 13px; flex: 1; }
.status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 99px;
  background: #f6f8fa;
  color: #6e7781;
}
.status-open, .status-open.status { background: #e8f5ed; color: #2da44e; }
.status-connecting { background: #fff5dc; color: #9a6700; }
.status-closed { background: #ffe9e7; color: #a40e26; }
.icon-btn {
  background: transparent;
  border: 0;
  font-size: 18px;
  cursor: pointer;
  color: #6e7781;
}
.icon-btn:hover { color: #1b1f23; }

.panel-actions {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #eaeef2;
  background: #fafbfc;
}
.panel-actions .me { font-size: 12px; display: flex; align-items: center; gap: 6px; color: #6e7781; margin-left: auto; }
.swatch { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
.primary {
  background: #2e7dd7;
  color: #fff;
  border: 1px solid #2e7dd7;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.primary:hover { filter: brightness(1.06); }
.cancel {
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}
.resolve, .reopen {
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.panel-threads {
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.section-heading {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: #6e7781;
  padding: 10px 6px 4px;
}
.thread {
  border: 1px solid #eaeef2;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 6px;
  cursor: pointer;
  background: #fff;
}
.thread:hover { border-color: #d1d5da; }
.thread.active { border-color: #2e7dd7; box-shadow: 0 0 0 2px rgba(46,125,215,0.15); }
.thread .meta {
  font-size: 11px;
  color: #6e7781;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.thread .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #e36f1e;
  display: inline-block;
}
.thread.status-resolved .dot { background: #2da44e; }
.thread.status-orphan .dot { background: #bf8700; }
.thread .time { margin-left: auto; color: #afb8c1; }
.thread .snippet {
  font-size: 11px;
  color: #6e7781;
  font-style: italic;
  border-left: 2px solid #eaeef2;
  padding: 2px 6px;
  margin-bottom: 4px;
  max-height: 2em;
  overflow: hidden;
}
.thread .last { font-size: 12px; color: #1b1f23; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty {
  padding: 16px 12px;
  color: #6e7781;
  font-size: 12px;
  text-align: center;
}

.composer {
  position: fixed;
  z-index: 2147483647;
  width: 300px;
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  padding: 10px;
}
.composer-snippet {
  font-size: 11px;
  color: #6e7781;
  font-style: italic;
  border-left: 2px solid #2e7dd7;
  padding: 2px 6px;
  margin-bottom: 6px;
  max-height: 4em;
  overflow: hidden;
}
.composer textarea {
  width: 100%;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  font-size: 13px;
  resize: vertical;
}
.composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}

.thread-popover {
  position: fixed;
  z-index: 2147483647;
  width: 320px;
  max-height: 60vh;
  background: #fff;
  border: 1px solid #d1d5da;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18);
  padding: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.thread-popover header {
  display: flex; align-items: center; gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #eaeef2;
  margin-bottom: 6px;
}
.thread-popover header .tag {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 99px;
}
.tag-open { background: #ecf3fb; color: #2e7dd7; }
.tag-resolved { background: #e8f5ed; color: #2da44e; }
.tag-orphan { background: #fff5dc; color: #bf8700; }
.thread-popover .snippet {
  font-size: 11px;
  font-style: italic;
  color: #6e7781;
  border-left: 2px solid #eaeef2;
  padding: 2px 6px;
  margin-bottom: 8px;
}
.thread-popover .comments {
  overflow-y: auto;
  flex: 1;
  padding-right: 2px;
  font-size: 13px;
}
.thread-popover .comment { padding: 4px 0; border-bottom: 1px solid #f6f8fa; }
.thread-popover .comment:last-child { border-bottom: 0; }
.thread-popover .author { font-size: 11px; color: #6e7781; margin-bottom: 2px; }
.thread-popover .author .swatch { margin-right: 4px; }
.thread-popover .author .time { margin-left: 6px; color: #afb8c1; }
.thread-popover .body { color: #1b1f23; }
.thread-popover .actions {
  display: flex; gap: 6px; padding-top: 8px; margin-top: 6px; border-top: 1px solid #eaeef2;
  flex-wrap: wrap;
  align-items: stretch;
}
.picker-banner {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  background: #1b1f23;
  color: #fff;
  padding: 8px 14px;
  border-radius: 99px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.25);
}
.picker-banner .picker-cancel {
  background: transparent;
  color: #fff;
  border: 1px solid rgba(255,255,255,0.3);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 12px;
  cursor: pointer;
}

.thread-popover .actions textarea {
  flex: 1 1 100%;
  min-width: 0;
  border: 1px solid #d1d5da;
  border-radius: 6px;
  padding: 6px;
  font: inherit;
  font-size: 12px;
  resize: vertical;
}
`;
