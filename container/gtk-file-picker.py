#!/usr/bin/env python3
"""Install Assistant UI: file picker, progress bar, and small alerts (GTK3/ctypes)."""
from __future__ import annotations

import ctypes
import ctypes.util
import os
import sys
import time


def _load(name: str) -> ctypes.CDLL:
    path = ctypes.util.find_library(name)
    if not path:
        raise RuntimeError(f"library not found: {name}")
    return ctypes.CDLL(path)


def _gtk_init(Gtk) -> bool:
    gchar_p = ctypes.c_char_p
    Gtk.gtk_init_check.argtypes = [
        ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.POINTER(gchar_p)),
    ]
    Gtk.gtk_init_check.restype = ctypes.c_bool
    argc = ctypes.c_int(0)
    argv = ctypes.POINTER(gchar_p)()
    return bool(Gtk.gtk_init_check(ctypes.byref(argc), ctypes.byref(argv)))


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: gtk-file-picker.py --menu|--pick|--choose-app|--progress|--info|--error ...",
            file=sys.stderr,
        )
        return 2

    mode = sys.argv[1]
    args = sys.argv[2:]
    Gtk = _load("gtk-3")
    if not _gtk_init(Gtk):
        print("GTK init failed", file=sys.stderr)
        return 2

    if mode == "--menu":
        return _menu(Gtk)
    if mode == "--pick":
        return _pick(Gtk, _load("glib-2.0"), args)
    if mode == "--choose-app":
        # args: JSON array of {name, package} or lines name|package
        return _choose_app(Gtk, args)
    if mode == "--progress":
        return _progress(Gtk, args[0] if args else "Working…")
    if mode in ("--info", "--error"):
        return _message(Gtk, mode, args[0] if args else "")
    return _pick(Gtk, _load("glib-2.0"), [mode, *args])


def _menu(Gtk) -> int:
    """Small action chooser: Install / Uninstall."""
    gpointer = ctypes.c_void_p
    gint = ctypes.c_int
    gchar_p = ctypes.c_char_p

    RESP_INSTALL = 1
    RESP_UNINSTALL = 2
    RESP_CANCEL = -6

    Gtk.gtk_dialog_new.argtypes = []
    Gtk.gtk_dialog_new.restype = gpointer
    Gtk.gtk_window_set_title.argtypes = [gpointer, gchar_p]
    Gtk.gtk_window_set_title.restype = None
    Gtk.gtk_window_set_default_size.argtypes = [gpointer, gint, gint]
    Gtk.gtk_window_set_default_size.restype = None
    Gtk.gtk_window_set_resizable.argtypes = [gpointer, ctypes.c_bool]
    Gtk.gtk_window_set_resizable.restype = None
    Gtk.gtk_dialog_get_content_area.argtypes = [gpointer]
    Gtk.gtk_dialog_get_content_area.restype = gpointer
    Gtk.gtk_box_pack_start.argtypes = [
        gpointer, gpointer, ctypes.c_bool, ctypes.c_bool, ctypes.c_uint,
    ]
    Gtk.gtk_box_pack_start.restype = None
    Gtk.gtk_label_new.argtypes = [gchar_p]
    Gtk.gtk_label_new.restype = gpointer
    Gtk.gtk_dialog_add_button.argtypes = [gpointer, gchar_p, gint]
    Gtk.gtk_dialog_add_button.restype = gpointer
    Gtk.gtk_dialog_run.argtypes = [gpointer]
    Gtk.gtk_dialog_run.restype = gint
    Gtk.gtk_widget_show_all.argtypes = [gpointer]
    Gtk.gtk_widget_show_all.restype = None
    Gtk.gtk_widget_destroy.argtypes = [gpointer]
    Gtk.gtk_widget_destroy.restype = None
    Gtk.gtk_container_set_border_width.argtypes = [gpointer, ctypes.c_uint]
    Gtk.gtk_container_set_border_width.restype = None

    dialog = Gtk.gtk_dialog_new()
    Gtk.gtk_window_set_title(dialog, b"Install Assistant")
    Gtk.gtk_window_set_default_size(dialog, 320, 120)
    Gtk.gtk_window_set_resizable(dialog, False)
    Gtk.gtk_container_set_border_width(dialog, 10)
    area = Gtk.gtk_dialog_get_content_area(dialog)
    lab = Gtk.gtk_label_new(b"What would you like to do?")
    Gtk.gtk_box_pack_start(area, lab, True, True, 8)
    Gtk.gtk_dialog_add_button(dialog, b"_Cancel", RESP_CANCEL)
    Gtk.gtk_dialog_add_button(dialog, b"_Uninstall", RESP_UNINSTALL)
    Gtk.gtk_dialog_add_button(dialog, b"_Install", RESP_INSTALL)
    Gtk.gtk_widget_show_all(dialog)
    resp = int(Gtk.gtk_dialog_run(dialog))
    try:
        Gtk.gtk_widget_destroy(dialog)
    except Exception:
        pass
    if resp == RESP_INSTALL:
        sys.stdout.write("install")
        sys.stdout.flush()
        try:
            open("/tmp/saaridge-menu-action", "w", encoding="utf-8").write("install")
        except OSError:
            pass
        os._exit(0)
    if resp == RESP_UNINSTALL:
        sys.stdout.write("uninstall")
        sys.stdout.flush()
        try:
            open("/tmp/saaridge-menu-action", "w", encoding="utf-8").write("uninstall")
        except OSError:
            pass
        os._exit(0)
    # Log unexpected responses to help diagnose VNC click quirks
    try:
        open("/tmp/saaridge-menu-action", "w", encoding="utf-8").write(f"cancel:{resp}")
    except OSError:
        pass
    return 1


def _choose_app(Gtk, args) -> int:
    """Pick an installed app. Input JSON via argv[0] or file path argv."""
    import json

    raw = args[0] if args else "[]"
    if raw.startswith("@") and os.path.isfile(raw[1:]):
        raw = open(raw[1:], encoding="utf-8").read()
    try:
        apps = json.loads(raw)
    except Exception:
        apps = []
    if not isinstance(apps, list) or not apps:
        print("No installed apps to uninstall", file=sys.stderr)
        return 1

    gpointer = ctypes.c_void_p
    gint = ctypes.c_int
    gchar_p = ctypes.c_char_p

    RESP_OK = -5
    RESP_CANCEL = -6

    Gtk.gtk_dialog_new.argtypes = []
    Gtk.gtk_dialog_new.restype = gpointer
    Gtk.gtk_window_set_title.argtypes = [gpointer, gchar_p]
    Gtk.gtk_window_set_title.restype = None
    Gtk.gtk_window_set_default_size.argtypes = [gpointer, gint, gint]
    Gtk.gtk_window_set_default_size.restype = None
    Gtk.gtk_dialog_get_content_area.argtypes = [gpointer]
    Gtk.gtk_dialog_get_content_area.restype = gpointer
    Gtk.gtk_box_pack_start.argtypes = [
        gpointer, gpointer, ctypes.c_bool, ctypes.c_bool, ctypes.c_uint,
    ]
    Gtk.gtk_box_pack_start.restype = None
    Gtk.gtk_label_new.argtypes = [gchar_p]
    Gtk.gtk_label_new.restype = gpointer
    Gtk.gtk_combo_box_text_new.argtypes = []
    Gtk.gtk_combo_box_text_new.restype = gpointer
    Gtk.gtk_combo_box_text_append_text.argtypes = [gpointer, gchar_p]
    Gtk.gtk_combo_box_text_append_text.restype = None
    Gtk.gtk_combo_box_set_active.argtypes = [gpointer, gint]
    Gtk.gtk_combo_box_set_active.restype = None
    Gtk.gtk_combo_box_get_active.argtypes = [gpointer]
    Gtk.gtk_combo_box_get_active.restype = gint
    Gtk.gtk_dialog_add_button.argtypes = [gpointer, gchar_p, gint]
    Gtk.gtk_dialog_add_button.restype = gpointer
    Gtk.gtk_dialog_run.argtypes = [gpointer]
    Gtk.gtk_dialog_run.restype = gint
    Gtk.gtk_widget_show_all.argtypes = [gpointer]
    Gtk.gtk_widget_show_all.restype = None
    Gtk.gtk_widget_destroy.argtypes = [gpointer]
    Gtk.gtk_widget_destroy.restype = None
    Gtk.gtk_container_set_border_width.argtypes = [gpointer, ctypes.c_uint]
    Gtk.gtk_container_set_border_width.restype = None

    dialog = Gtk.gtk_dialog_new()
    Gtk.gtk_window_set_title(dialog, b"Uninstall")
    Gtk.gtk_window_set_default_size(dialog, 360, 140)
    Gtk.gtk_container_set_border_width(dialog, 10)
    area = Gtk.gtk_dialog_get_content_area(dialog)
    lab = Gtk.gtk_label_new(b"Select an application to uninstall:")
    Gtk.gtk_box_pack_start(area, lab, False, False, 6)
    combo = Gtk.gtk_combo_box_text_new()
    for app in apps:
        label = str(app.get("name") or app.get("package") or "App")
        Gtk.gtk_combo_box_text_append_text(combo, label.encode())
    Gtk.gtk_combo_box_set_active(combo, 0)
    Gtk.gtk_box_pack_start(area, combo, False, False, 6)
    Gtk.gtk_dialog_add_button(dialog, b"_Cancel", RESP_CANCEL)
    Gtk.gtk_dialog_add_button(dialog, b"_Uninstall", RESP_OK)
    Gtk.gtk_widget_show_all(dialog)
    resp = int(Gtk.gtk_dialog_run(dialog))
    idx = int(Gtk.gtk_combo_box_get_active(combo))
    try:
        Gtk.gtk_widget_destroy(dialog)
    except Exception:
        pass
    if resp != RESP_OK or idx < 0 or idx >= len(apps):
        return 1
    pkg = str(apps[idx].get("package") or "")
    if not pkg:
        return 1
    sys.stdout.write(pkg)
    sys.stdout.flush()
    try:
        open("/tmp/saaridge-uninstall-pkg", "w", encoding="utf-8").write(pkg)
    except OSError:
        pass
    os._exit(0)


def _message(Gtk, kind: str, text: str) -> int:
    gpointer = ctypes.c_void_p
    gint = ctypes.c_int
    gchar_p = ctypes.c_char_p
    GTK_MESSAGE_INFO = 0
    GTK_MESSAGE_ERROR = 3
    GTK_BUTTONS_OK = 1

    msg_type = GTK_MESSAGE_ERROR if kind == "--error" else GTK_MESSAGE_INFO
    title = b"Install failed" if kind == "--error" else b"Install"

    Gtk.gtk_message_dialog_new.restype = gpointer
    dialog = Gtk.gtk_message_dialog_new(
        None, 0, msg_type, GTK_BUTTONS_OK, b"%s",
        (text or "").encode(), None,
    )
    if not dialog:
        print(text)
        return 0

    Gtk.gtk_window_set_title.argtypes = [gpointer, gchar_p]
    Gtk.gtk_window_set_title.restype = None
    Gtk.gtk_window_set_default_size.argtypes = [gpointer, gint, gint]
    Gtk.gtk_window_set_default_size.restype = None
    Gtk.gtk_dialog_run.argtypes = [gpointer]
    Gtk.gtk_dialog_run.restype = gint
    Gtk.gtk_widget_destroy.argtypes = [gpointer]
    Gtk.gtk_widget_destroy.restype = None

    Gtk.gtk_window_set_title(dialog, title)
    Gtk.gtk_window_set_default_size(dialog, 340, 110)
    Gtk.gtk_dialog_run(dialog)
    try:
        Gtk.gtk_widget_destroy(dialog)
    except Exception:
        pass
    os._exit(0)


def _progress(Gtk, label: str) -> int:
    """Show a pulsing progress window until /tmp/saaridge-install-done appears."""
    gpointer = ctypes.c_void_p
    gint = ctypes.c_int
    gchar_p = ctypes.c_char_p
    gdouble = ctypes.c_double

    Gtk.gtk_window_new.argtypes = [gint]
    Gtk.gtk_window_new.restype = gpointer
    Gtk.gtk_window_set_title.argtypes = [gpointer, gchar_p]
    Gtk.gtk_window_set_title.restype = None
    Gtk.gtk_window_set_default_size.argtypes = [gpointer, gint, gint]
    Gtk.gtk_window_set_default_size.restype = None
    Gtk.gtk_window_set_resizable.argtypes = [gpointer, ctypes.c_bool]
    Gtk.gtk_window_set_resizable.restype = None
    Gtk.gtk_window_set_position.argtypes = [gpointer, gint]
    Gtk.gtk_window_set_position.restype = None
    Gtk.gtk_box_new.argtypes = [gint, gint]
    Gtk.gtk_box_new.restype = gpointer
    Gtk.gtk_container_add.argtypes = [gpointer, gpointer]
    Gtk.gtk_container_add.restype = None
    Gtk.gtk_container_set_border_width.argtypes = [gpointer, ctypes.c_uint]
    Gtk.gtk_container_set_border_width.restype = None
    Gtk.gtk_label_new.argtypes = [gchar_p]
    Gtk.gtk_label_new.restype = gpointer
    Gtk.gtk_box_pack_start.argtypes = [
        gpointer, gpointer, ctypes.c_bool, ctypes.c_bool, ctypes.c_uint,
    ]
    Gtk.gtk_box_pack_start.restype = None
    Gtk.gtk_progress_bar_new.argtypes = []
    Gtk.gtk_progress_bar_new.restype = gpointer
    Gtk.gtk_progress_bar_pulse.argtypes = [gpointer]
    Gtk.gtk_progress_bar_pulse.restype = None
    Gtk.gtk_progress_bar_set_text.argtypes = [gpointer, gchar_p]
    Gtk.gtk_progress_bar_set_text.restype = None
    Gtk.gtk_progress_bar_set_show_text.argtypes = [gpointer, ctypes.c_bool]
    Gtk.gtk_progress_bar_set_show_text.restype = None
    Gtk.gtk_widget_show_all.argtypes = [gpointer]
    Gtk.gtk_widget_show_all.restype = None
    Gtk.gtk_widget_destroy.argtypes = [gpointer]
    Gtk.gtk_widget_destroy.restype = None
    Gtk.gtk_events_pending.argtypes = []
    Gtk.gtk_events_pending.restype = ctypes.c_bool
    Gtk.gtk_main_iteration_do.argtypes = [ctypes.c_bool]
    Gtk.gtk_main_iteration_do.restype = ctypes.c_bool

    GTK_WINDOW_TOPLEVEL = 0
    GTK_WIN_POS_CENTER = 1
    GTK_ORIENTATION_VERTICAL = 1

    done_path = "/tmp/saaridge-install-done"
    try:
        os.remove(done_path)
    except OSError:
        pass

    win = Gtk.gtk_window_new(GTK_WINDOW_TOPLEVEL)
    Gtk.gtk_window_set_title(win, b"Install")
    Gtk.gtk_window_set_default_size(win, 360, 90)
    Gtk.gtk_window_set_resizable(win, False)
    Gtk.gtk_window_set_position(win, GTK_WIN_POS_CENTER)
    Gtk.gtk_container_set_border_width(win, 14)

    box = Gtk.gtk_box_new(GTK_ORIENTATION_VERTICAL, 10)
    Gtk.gtk_container_add(win, box)

    lab = Gtk.gtk_label_new((label or "Installing…").encode())
    Gtk.gtk_box_pack_start(box, lab, False, False, 0)

    bar = Gtk.gtk_progress_bar_new()
    Gtk.gtk_progress_bar_set_show_text(bar, True)
    Gtk.gtk_progress_bar_set_text(bar, b"Please wait")
    Gtk.gtk_box_pack_start(box, bar, False, False, 0)

    Gtk.gtk_widget_show_all(win)

    # Pulse until the installer signals completion (or we are asked to stop).
    stop = {"v": False}

    def _handle_sig(_signum, _frame):
        stop["v"] = True

    try:
        import signal
        signal.signal(signal.SIGTERM, _handle_sig)
        signal.signal(signal.SIGINT, _handle_sig)
    except Exception:
        pass

    while not stop["v"] and not os.path.exists(done_path):
        Gtk.gtk_progress_bar_pulse(bar)
        # Process pending UI events without spinning forever.
        for _ in range(8):
            if not Gtk.gtk_events_pending():
                break
            Gtk.gtk_main_iteration_do(False)
        time.sleep(0.1)

    try:
        Gtk.gtk_widget_destroy(win)
    except Exception:
        pass
    try:
        os.remove(done_path)
    except OSError:
        pass
    os._exit(0)


def _pick(Gtk, GLib, args) -> int:
    gpointer = ctypes.c_void_p
    gint = ctypes.c_int
    gchar_p = ctypes.c_char_p

    GTK_FILE_CHOOSER_ACTION_OPEN = 0
    GTK_RESPONSE_ACCEPT = -3
    GTK_RESPONSE_CANCEL = -6

    title = (args[0] if args else "Install").encode()
    start = (args[1] if len(args) > 1 else os.path.expanduser("~")).encode()

    Gtk.gtk_file_chooser_dialog_new.restype = gpointer
    Gtk.gtk_dialog_add_button.argtypes = [gpointer, gchar_p, gint]
    Gtk.gtk_dialog_add_button.restype = gpointer
    Gtk.gtk_file_chooser_set_current_folder.argtypes = [gpointer, gchar_p]
    Gtk.gtk_file_chooser_set_current_folder.restype = ctypes.c_int
    Gtk.gtk_window_set_default_size.argtypes = [gpointer, gint, gint]
    Gtk.gtk_window_set_default_size.restype = None
    Gtk.gtk_dialog_run.argtypes = [gpointer]
    Gtk.gtk_dialog_run.restype = gint
    Gtk.gtk_file_chooser_get_filename.argtypes = [gpointer]
    Gtk.gtk_file_chooser_get_filename.restype = ctypes.c_void_p
    Gtk.gtk_widget_hide.argtypes = [gpointer]
    Gtk.gtk_widget_hide.restype = None
    Gtk.gtk_widget_destroy.argtypes = [gpointer]
    Gtk.gtk_widget_destroy.restype = None
    GLib.g_free.argtypes = [gpointer]
    GLib.g_free.restype = None

    dialog = Gtk.gtk_file_chooser_dialog_new(title, None, GTK_FILE_CHOOSER_ACTION_OPEN, None)
    if not dialog:
        print("Failed to create file chooser", file=sys.stderr)
        return 2

    Gtk.gtk_window_set_default_size(dialog, 560, 380)
    Gtk.gtk_dialog_add_button(dialog, b"_Cancel", GTK_RESPONSE_CANCEL)
    Gtk.gtk_dialog_add_button(dialog, b"_Install", GTK_RESPONSE_ACCEPT)
    Gtk.gtk_file_chooser_set_current_folder(dialog, start)

    response = int(Gtk.gtk_dialog_run(dialog))
    path = None
    if response == GTK_RESPONSE_ACCEPT:
        raw = Gtk.gtk_file_chooser_get_filename(dialog)
        if raw:
            path = ctypes.string_at(raw).decode("utf-8", "surrogateescape")
            GLib.g_free(raw)

    try:
        Gtk.gtk_widget_hide(dialog)
    except Exception:
        pass

    if not path:
        try:
            Gtk.gtk_widget_destroy(dialog)
        except Exception:
            pass
        return 1

    sys.stdout.write(path)
    sys.stdout.flush()
    try:
        with open("/tmp/saaridge-picked-path", "w", encoding="utf-8") as fh:
            fh.write(path)
    except OSError:
        pass
    os._exit(0)


if __name__ == "__main__":
    raise SystemExit(main())
