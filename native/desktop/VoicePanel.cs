using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Text.RegularExpressions;
using System.Linq;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace Sonicloud {
    sealed class Insertion {
        AutomationElement element;
        string original;
        int[] runtime;
        int start, length;
        static bool Read(AutomationElement target, out string value, out int offset, out int count) {
            value = ""; offset = count = 0;
            object vp, tp;
            if (target.Current.IsPassword || !target.TryGetCurrentPattern(ValuePattern.Pattern, out vp)
                || ((ValuePattern)vp).Current.IsReadOnly || !target.TryGetCurrentPattern(TextPattern.Pattern, out tp)) return false;
            value = ((ValuePattern)vp).Current.Value;
            var pattern = (TextPattern)tp;
            var selected = pattern.GetSelection();
            if (selected.Length != 1) return false;
            var before = pattern.DocumentRange.Clone();
            before.MoveEndpointByRange(TextPatternRangeEndpoint.End, selected[0], TextPatternRangeEndpoint.Start);
            offset = before.GetText(-1).Length; count = selected[0].GetText(-1).Length;
            // UIA text/value views must agree before making any replacement.
            return pattern.DocumentRange.GetText(-1) == value && offset + count <= value.Length;
        }
        public static Insertion Capture() {
            try {
                var target = AutomationElement.FocusedElement;
                string value; int offset, count;
                if (target == null || !Read(target, out value, out offset, out count)) return null;
                return new Insertion { element = target, runtime = target.GetRuntimeId(), original = value, start = offset, length = count };
            } catch { return null; }
        }
        public bool Insert(string text) {
            try {
                var current = AutomationElement.FocusedElement;
                string value; int offset, count;
                if (current == null || !current.GetRuntimeId().SequenceEqual(runtime)
                    || !Read(current, out value, out offset, out count) || value != original || offset != start || count != length) return false;
                ((ValuePattern)element.GetCurrentPattern(ValuePattern.Pattern)).SetValue(original.Substring(0, start) + text + original.Substring(start + length));
                // Setting value succeeded; caret placement is best effort, never repeat insertion.
                try {
                    var range = ((TextPattern)element.GetCurrentPattern(TextPattern.Pattern)).DocumentRange;
                    range.MoveEndpointByRange(TextPatternRangeEndpoint.End, range, TextPatternRangeEndpoint.Start);
                    range.Move(TextUnit.Character, start + text.Length); range.Select();
                } catch { }
                return true;
            } catch { return false; }
        }
    }
    static class CapsuleShape {
        public static GraphicsPath Create(RectangleF bounds, float radius) {
            var path = new GraphicsPath(); var diameter = radius * 2;
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure(); return path;
        }
    }
    sealed class SingleLineText : Control {
        public SingleLineText() { SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true); }
        protected override void OnPaint(PaintEventArgs e) {
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ForeColor,
                TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding);
        }
        protected override void OnTextChanged(EventArgs e) { base.OnTextChanged(e); Invalidate(); }
    }
    sealed class Waveform : Control {
        public double Phase;
        public Waveform() { SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true); }
        protected override void OnPaint(PaintEventArgs e) {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var brush = new SolidBrush(Color.SeaGreen)) {
                for (int i = 0; i < 5; i++) {
                    float height = (float)(7 + 18 * (0.5 + 0.5 * Math.Sin(Phase * (1 + i % 3 * 0.12) + i * 0.9)));
                    using (var bar = CapsuleShape.Create(new RectangleF(i * 5, (Height - height) / 2, 3, height), 1.5f)) e.Graphics.FillPath(brush, bar);
                }
            }
        }
    }
    public sealed class VoicePanel : Form {
        readonly SingleLineText text = new SingleLineText();
        readonly Waveform waveform = new Waveform();
        readonly Button close = new Button(), copy = new Button();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 300000 };
        readonly System.Windows.Forms.Timer pulse = new System.Windows.Forms.Timer { Interval = 40 };
        string session = "", preview = "", phase = "", message = "";
        bool active;
        Insertion insertion;
        Screen screen;
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000080; return p; }
        }
        protected override void WndProc(ref Message m) {
            if (m.Msg == 0x21) { m.Result = new IntPtr(3); return; }
            base.WndProc(ref m);
        }
        VoicePanel() {
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
            BackColor = Color.White; Font = new Font("Microsoft YaHei UI", 10);
            AccessibleName = "声云语音";
            text.AccessibleName = "语音识别结果";
            close.Text = ""; close.FlatStyle = FlatStyle.Flat; close.FlatAppearance.BorderSize = 0;
            var icon = new Bitmap(16, 16);
            using (var graphics = Graphics.FromImage(icon))
            using (var pen = new Pen(Color.DimGray, 1.8f)) {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                pen.StartCap = pen.EndCap = LineCap.Round;
                graphics.DrawLine(pen, 3, 3, 12, 12); graphics.DrawLine(pen, 12, 3, 3, 12);
            }
            close.Image = icon; close.AccessibleName = "取消";
            copy.Text = "复制结果";
            Controls.AddRange(new Control[] { text, waveform, close, copy });
            close.Click += delegate {
                if (active) Emit(new Dictionary<string, object> { { "event", "cancel" }, { "sessionId", session } });
                active = false; insertion = null; preview = message = ""; Hide();
            };
            copy.Click += delegate { try { Clipboard.SetText(preview); copy.Text = "已复制"; } catch { copy.Text = "复制失败"; } };
            pulse.Tick += delegate { waveform.Phase += 0.25; waveform.Invalidate(); };
            VisibleChanged += delegate { pulse.Enabled = Visible && active; };
            Microsoft.Win32.SystemEvents.DisplaySettingsChanged += DisplayChanged;
            FormClosed += delegate { pulse.Dispose(); close.Image.Dispose(); Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= DisplayChanged; };
        }
        void DisplayChanged(object sender, EventArgs e) { if (!IsDisposed && Visible) BeginInvoke((Action)Render); }
        void Render() {
            var display = Screen.AllScreens.FirstOrDefault(s => screen != null && s.DeviceName == screen.DeviceName) ?? Screen.PrimaryScreen;
            var area = display.WorkingArea; var width = Math.Min(720, area.Width - 48); var height = 48;
            Bounds = new Rectangle(area.Left + (area.Width - width) / 2, area.Bottom - height - 24, width, height);
            using (var outline = CapsuleShape.Create(new RectangleF(0, 0, width, height), height / 2f)) {
                var previous = Region; Region = new Region(outline); if (previous != null) previous.Dispose();
            }
            waveform.SetBounds(20, (height - 26) / 2, 23, 26);
            close.SetBounds(width - 44, (height - 28) / 2, 28, 28); copy.SetBounds(width - 146, (height - 32) / 2, 96, 32);
            waveform.Visible = active; copy.Visible = !active && preview.Length > 0; close.AccessibleName = active ? "取消" : "关闭";
            int left = active ? 54 : 22, right = copy.Visible ? copy.Left : close.Left;
            text.SetBounds(left, 0, Math.Max(0, right - left - 12), height);
            string status = message.Length > 0 ? message : phase == "finishing" ? "正在整理…" : phase == "translating" ? "正在翻译…" : "";
            string displayText = (status + " " + preview).Trim();
            text.Text = Regex.Replace(displayText, @"[\r\n\t\u0085\u2028\u2029]+", " ");
            pulse.Enabled = active;
            Show();
        }
        static string Get(Dictionary<string, object> item, string key) { object value; return item.TryGetValue(key, out value) ? Convert.ToString(value) : ""; }
        void Emit(Dictionary<string, object> value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
        void HandleCommand(Dictionary<string, object> item) {
            string command = Get(item, "command"), incoming = Get(item, "sessionId"); bool ok = true, inserted = false;
            if (command == "begin") {
                session = incoming; preview = message = ""; phase = "connecting"; active = true;
                insertion = Get(item, "action") == "speechSearch" ? null : Insertion.Capture();
                screen = Screen.FromPoint(Cursor.Position); copy.Text = "复制结果"; Render();
            } else if (incoming.Length > 0 && incoming != session) ok = false;
            else if (command == "result" && active) {
                preview = Get(item, "text"); inserted = insertion != null && insertion.Insert(preview);
                insertion = null; active = false;
                if (inserted) Hide(); else { message = "未回填，可复制结果"; Render(); }
            } else if (command == "event") {
                switch (Get(item, "type")) {
                    case "preview": if (active) { preview = Get(item, "text"); Render(); } break;
                    case "phase": if (active) { phase = Get(item, "phase"); Render(); } break;
                    case "notice": message = Get(item, "message"); Render(); break;
                    case "failed": active = false; insertion = null; message = Get(item, "message"); Render(); break;
                    case "cancelled": case "finished": active = false; insertion = null; preview = message = ""; Hide(); break;
                }
            } else ok = false;
            object id; if (item.TryGetValue("id", out id)) Emit(new Dictionary<string, object> { { "id", id }, { "ok", ok }, { "value", inserted } });
        }
        [STAThread] public static void Run() {
            Application.EnableVisualStyles();
            using (var form = new VoicePanel()) {
                var handle = form.Handle;
                var input = new Thread(() => {
                    string line;
                    while ((line = Console.ReadLine()) != null) {
                        if (line.Length > 300000) continue;
                        try {
                            var item = new JavaScriptSerializer { MaxJsonLength = 300000 }.Deserialize<Dictionary<string, object>>(line);
                            form.BeginInvoke((Action)(() => form.HandleCommand(item)));
                        } catch { }
                    }
                    if (!form.IsDisposed) form.BeginInvoke((Action)(() => Application.ExitThread()));
                });
                input.IsBackground = true; input.Start();
                Application.Run();
            }
        }
    }
}
