using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Linq;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;
using System.Web.Script.Serialization;

namespace Sonicloud {
    // typer.dll 标准注入库（纯 C ABI）：会话式逐字打字，实时退格更正，逐字模式不占用剪贴板。
    static class Typer {
        public const int ModePerChar = 0;
        public const int ErrInvalidArg = -1, ErrNotSupported = -2, ErrAccessDenied = -4, ErrWrongState = -6, ErrQueueFull = -8;
        public delegate void ErrorCallback(IntPtr user, int code);
        // typer_config v1.1 布局（x64 自然对齐与 C 一致）；drained_cb 不用，置空。
        [StructLayout(LayoutKind.Sequential)]
        public struct Config {
            public IntPtr size, drained_cb, drained_user;
            public int xkb_bind_delay_ms, xkb_char_interval_ms, xdotool_char_delay_ms, xclip_settle_ms,
                paste_settle_ms, ime_settle_ms, proc_timeout_ms, queue_limit;
            public IntPtr error_cb, error_user;
        }
        // typer_caps 完整布局（含尾部 char ime_tool_path[260]，探测要求 size 覆盖全结构）。
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
        public struct Caps {
            public IntPtr size;
            public int session_type, text_typing, increment_typing, whole_phrase_paste, ime_guard,
                input_permitted, has_xdotool, has_xclip, has_fcitx_remote;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ime_tool_path;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string path);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr typer_create(ref Config config);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern void typer_destroy(IntPtr ctx);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int typer_session_begin(IntPtr ctx, int mode);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int typer_feed_partial(IntPtr ctx, byte[] utf8);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int typer_feed_final(IntPtr ctx, byte[] utf8);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int typer_session_end(IntPtr ctx);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int typer_session_abort(IntPtr ctx);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern int typer_probe(ref Caps caps);
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr typer_version();
        [DllImport("typer.dll", CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr typer_strerror(int code);
        public static bool loaded;
        public static void Load(string directory) {
            try {
                if (LoadLibrary(System.IO.Path.Combine(directory, "typer.dll")) == IntPtr.Zero) return;
                StringAt(typer_version()); // 触发一次导出调用，确认模块与 ABI 可用
                loaded = true;
            } catch { loaded = false; }
        }
        public static string StringAt(IntPtr pointer) { return pointer == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(pointer); }
    }
    // 面板持有的 typer 会话封装；error 回调来自库内打字线程，只做投递，不在回调内再调 typer_*。
    sealed class TyperEngine {
        static Action<int> notify;
        static readonly Typer.ErrorCallback errorCallback = OnNativeError;
        static void OnNativeError(IntPtr user, int code) { Action<int> handler = notify; if (handler != null) handler(code); }
        public IntPtr context;
        public bool Open(Action<int> onError) {
            if (!Typer.loaded) return false;
            var config = new Typer.Config();
            config.size = (IntPtr)Marshal.SizeOf(typeof(Typer.Config));
            config.queue_limit = 1024; // 默认 256，长语音的中间结果可能更多
            config.error_cb = Marshal.GetFunctionPointerForDelegate(errorCallback);
            try { context = Typer.typer_create(ref config); } catch { context = IntPtr.Zero; }
            if (context == IntPtr.Zero) return false;
            notify = onError;
            return true;
        }
        public void Close() {
            if (context != IntPtr.Zero) { Typer.typer_destroy(context); context = IntPtr.Zero; }
            notify = null;
        }
        public int Begin(int mode) { return context == IntPtr.Zero ? Typer.ErrNotSupported : Typer.typer_session_begin(context, mode); }
        public int Partial(string text) { return context == IntPtr.Zero ? Typer.ErrNotSupported : Typer.typer_feed_partial(context, Bytes(text)); }
        public int Final(string text) { return context == IntPtr.Zero ? Typer.ErrNotSupported : Typer.typer_feed_final(context, Bytes(text)); }
        public int End() { return context == IntPtr.Zero ? Typer.ErrNotSupported : Typer.typer_session_end(context); }
        public int Abort() { return context == IntPtr.Zero ? Typer.ErrNotSupported : Typer.typer_session_abort(context); }
        public static string ErrorText(int code) {
            switch (code) {
                case Typer.ErrInvalidArg: return "文本包含不支持的字符";
                case Typer.ErrAccessDenied: return "目标窗口拒绝模拟输入";
                case Typer.ErrWrongState: return "打字会话已中断";
                case Typer.ErrQueueFull: return "打字任务过多，请稍候";
                default: return "打字失败（代码 " + code + "）";
            }
        }
        static byte[] Bytes(string text) {
            if (string.IsNullOrEmpty(text)) return new byte[] { 0 };
            byte[] data = Encoding.UTF8.GetBytes(text);
            Array.Resize(ref data, data.Length + 1); // 追加 NUL 终止
            return data;
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
        readonly Button close = new Button(), copy = new Button(), submit = new Button();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 300000 };
        readonly System.Windows.Forms.Timer pulse = new System.Windows.Forms.Timer { Interval = 40 };
        string session = "", preview = "", phase = "", message = "";
        bool active;
        TyperEngine typer;
        bool sessionTyping;  // typer 会话已 begin 且未 end/abort
        bool typingLive;     // voice_input：中间结果实时逐字打进目标窗口
        bool typingBlocked;  // 密码框 / 组件不可用，本次会话拒绝打字
        string blockedReason = "";
        bool typingError;    // 注入失败已闩（error_cb），后续 feed/end 只会返回 WRONG_STATE
        int typingErrorCode;
        bool pendingSubmit;  // 宿主 submitOffer：文本留在浮窗，等用户放好焦点后一键提交
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
            submit.Text = "一键提交"; submit.AccessibleName = "一键提交";
            Controls.AddRange(new Control[] { text, waveform, close, copy, submit });
            close.Click += delegate {
                if (active) Emit(new Dictionary<string, object> { { "event", "cancel" }, { "sessionId", session } });
                EndSession(); preview = message = ""; pendingSubmit = false; Hide();
            };
            submit.Click += delegate { SubmitPending(); };
            copy.Click += delegate { try { Clipboard.SetText(preview); copy.Text = "已复制"; } catch { copy.Text = "复制失败"; } };
            pulse.Tick += delegate { waveform.Phase += 0.25; waveform.Invalidate(); };
            VisibleChanged += delegate { pulse.Enabled = Visible && active; };
            Microsoft.Win32.SystemEvents.DisplaySettingsChanged += DisplayChanged;
            FormClosed += delegate { pulse.Dispose(); close.Image.Dispose(); Microsoft.Win32.SystemEvents.DisplaySettingsChanged -= DisplayChanged; };
            Disposed += delegate { EndSession(); if (typer != null) { typer.Close(); typer = null; } };
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
            close.SetBounds(width - 44, (height - 28) / 2, 28, 28);
            if (pendingSubmit) {
                submit.SetBounds(width - 148, (height - 32) / 2, 96, 32);
                copy.SetBounds(width - 252, (height - 32) / 2, 96, 32);
            } else copy.SetBounds(width - 146, (height - 32) / 2, 96, 32);
            waveform.Visible = active; submit.Visible = pendingSubmit;
            copy.Visible = !active && preview.Length > 0; close.AccessibleName = active ? "取消" : "关闭";
            int left = active ? 54 : 22, right = copy.Visible ? copy.Left : close.Left;
            text.SetBounds(left, 0, Math.Max(0, right - left - 12), height);
            string status = message.Length > 0 ? message : phase == "finishing" ? "正在整理…" : phase == "translating" ? "正在翻译…" : "";
            string displayText = (status + " " + preview).Trim();
            text.Text = Regex.Replace(displayText, @"[\r\n\t\u0085\u2028\u2029]+", " ");
            pulse.Enabled = Visible && active;
            Show();
        }
        static string Get(Dictionary<string, object> item, string key) { object value; return item.TryGetValue(key, out value) ? Convert.ToString(value) : ""; }
        void Emit(Dictionary<string, object> value) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); }
        // UIA 不可达时放行（fail-open）：最坏情况等于无密码检查的直接注入。
        static bool FocusedElementIsPassword() {
            try { var element = AutomationElement.FocusedElement; return element != null && element.Current.IsPassword; }
            catch { return false; }
        }
        void EndSession() {
            active = false; typingLive = false;
            if (sessionTyping) { sessionTyping = false; if (typer != null) typer.Abort(); }
        }
        void HandleTypingError(int code) {
            typingError = true; typingErrorCode = code;
            message = "未回填：" + TyperEngine.ErrorText(code) + "，可复制结果";
            Render();
        }
        // 一键提交：把保留的文本一次性逐字注入点击时聚焦的窗口（浮窗不抢焦点，焦点仍在用户摆好的目标上）。
        void SubmitPending() {
            if (!pendingSubmit) return;
            pendingSubmit = false;
            string reason = null;
            if (typer == null || typer.context == IntPtr.Zero) reason = "打字组件不可用";
            else if (FocusedElementIsPassword()) reason = "目标为密码输入框";
            else {
                int rc = typer.Begin(Typer.ModePerChar);
                if (rc != 0) reason = TyperEngine.ErrorText(rc);
                else {
                    sessionTyping = true;
                    rc = typer.Final(preview);
                    if (rc == 0) { typer.End(); sessionTyping = false; }
                    else { typer.Abort(); sessionTyping = false; reason = TyperEngine.ErrorText(rc); }
                }
            }
            if (reason == null) { preview = message = ""; Hide(); }
            else { message = "未回填：" + reason + "，可复制结果"; Render(); }
        }
        void HandleCommand(Dictionary<string, object> item) {
            string command = Get(item, "command"), incoming = Get(item, "sessionId"); bool ok = true, inserted = false;
            if (command == "begin") {
                session = incoming; preview = message = ""; phase = "connecting"; active = true;
                string action = Get(item, "action");
                typingBlocked = false; typingError = false; sessionTyping = false; typingLive = false; pendingSubmit = false;
                if (action == "voice_input" || action == "translate") {
                    typingLive = action == "voice_input"; // 翻译只在最终译文出来后打字，避免先打原文再整段退格
                    if (typer == null || typer.context == IntPtr.Zero) { typingBlocked = true; blockedReason = "打字组件不可用"; }
                    else if (FocusedElementIsPassword()) { typingBlocked = true; blockedReason = "目标为密码输入框"; }
                    else {
                        int rc = typer.Begin(Typer.ModePerChar);
                        if (rc == 0) sessionTyping = true;
                        else { typingBlocked = true; blockedReason = TyperEngine.ErrorText(rc); }
                    }
                }
                screen = Screen.FromPoint(Cursor.Position); copy.Text = "复制结果"; Render();
            } else if (incoming.Length > 0 && incoming != session) { ok = false; }
            else if (command == "result" && active) {
                preview = Get(item, "text");
                string reason = null;
                if (typingBlocked) reason = blockedReason;
                else if (typingError) reason = TyperEngine.ErrorText(typingErrorCode);
                else if (sessionTyping) {
                    int rc = typer.Final(preview);
                    if (rc != 0) reason = TyperEngine.ErrorText(rc);
                    else { typer.End(); sessionTyping = false; }
                }
                EndSession();
                if (reason == null) { inserted = true; Hide(); }
                else { message = "未回填：" + reason + "，可复制结果"; Render(); }
            } else if (command == "event") {
                switch (Get(item, "type")) {
                    case "preview":
                        if (active) {
                            preview = Get(item, "text");
                            if (typingLive && sessionTyping && !typingError) typer.Partial(preview);
                            Render();
                        }
                        break;
                    case "phase": if (active) { phase = Get(item, "phase"); Render(); } break;
                    case "notice": message = Get(item, "message"); Render(); break;
                    case "failed": EndSession(); message = Get(item, "message"); Render(); break;
                    case "submitOffer":
                        // 宿主无法填入 Harness 对话（窗口/渲染不可达）：文本留在浮窗，交给一键提交注入当前焦点窗口。
                        preview = Get(item, "text");
                        EndSession();
                        typingError = false; // 清闩，本次提交允许重新注入
                        pendingSubmit = preview.Length > 0;
                        message = pendingSubmit ? Get(item, "message") : "没有可输入的内容";
                        if (message.Length == 0) message = "请打开需要输入界面";
                        copy.Text = "复制结果"; Render();
                        break;
                    case "cancelled": case "finished":
                        // 空结果收尾（无 result）：实时打出的中间结果用空 partial 修正掉，再结束会话。
                        if (sessionTyping && typingLive && !typingError) { typer.Partial(""); typer.End(); sessionTyping = false; }
                        EndSession(); preview = message = ""; Hide();
                        break;
                }
            } else ok = false;
            object id; if (item.TryGetValue("id", out id)) Emit(new Dictionary<string, object> { { "id", id }, { "ok", ok }, { "value", inserted } });
        }
        [STAThread] public static void Run(string dllDirectory) {
            Typer.Load(dllDirectory);
            Application.EnableVisualStyles();
            using (var form = new VoicePanel()) {
                var handle = form.Handle; // 先建句柄，后台线程的 BeginInvoke 才有目标
                form.typer = new TyperEngine();
                form.typer.Open(code => { if (!form.IsDisposed) form.BeginInvoke((Action)(() => form.HandleTypingError(code))); });
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
