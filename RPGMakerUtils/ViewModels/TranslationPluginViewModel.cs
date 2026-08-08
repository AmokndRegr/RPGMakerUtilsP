using CommunityToolkit.Mvvm.Input;
using CommunityToolkit.Mvvm.Messaging;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PropertyChanged;
using RPGMakerUtils.Messages;
using RPGMakerUtils.Models;
using RPGMakerUtils.Resources;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;

namespace RPGMakerUtils.ViewModels
{

    [AddINotifyPropertyChangedInterface]
    internal class TranslationPluginViewModel : CommonViewModel
    {
        public string TranslateJsonPath { get; set; } = string.Empty;

        public readonly string PluginLine = "{\"name\":\"JtJsonTranslationManager\",\"status\":true,\"description\":\"Loads translations.json and applies it to game text.\",\"parameters\":{}},";

        public IAsyncRelayCommand AddTranslationPluginCommand { get; }

        public IAsyncRelayCommand RestoreCommand { get; }

        public TranslationPluginViewModel()
        {
            AddTranslationPluginCommand = new AsyncRelayCommand(AddTranslationPluginAsync, CanAddTranslationPlugin);
            RestoreCommand = new AsyncRelayCommand(RestoreAsync, CanRestore);

            WeakReferenceMessenger.Default.Register<ProgramRunningMessage>(this, (r, m) =>
            {
                IsRunning = m.Value;
                AddTranslationPluginCommand.NotifyCanExecuteChanged();
                RestoreCommand.NotifyCanExecuteChanged();
                OnPropertyChanged(nameof(TranslationPluginPath));
            });
            WeakReferenceMessenger.Default.Register<GameInfoUpdatedMessage>(this, (r, m) =>
            {
                GamePath = m.Value.GamePath;
                GameVersion = m.Value.GameVersion;
                OnPropertyChanged(nameof(GameJsPath));
                OnPropertyChanged(nameof(GamePluginsJsPath));
                OnPropertyChanged(nameof(TranslationPluginPath));
                OnPropertyChanged(nameof(GameWwwPath));
                OnPropertyChanged(nameof(TargetJsonPath));
                AddTranslationPluginCommand.NotifyCanExecuteChanged();
                RestoreCommand.NotifyCanExecuteChanged();
            });
            WeakReferenceMessenger.Default.Register<TranslateJsonUpdatedMessage>(this, (r, m) =>
            {
                TranslateJsonPath = m.Value;
                OnPropertyChanged(nameof(TranslateJsonPath));
                AddTranslationPluginCommand.NotifyCanExecuteChanged();
                RestoreCommand.NotifyCanExecuteChanged();
            });

            // Plugin ComboBox
            SelectedPluginVersion = PluginVersions.ComprehensiveTranslation;
            AvailablePluginVersions = new List<string>
            {
                PluginVersions.BroaderTranslation,
                PluginVersions.FasterTranslation,
                PluginVersions.ComprehensiveTranslation
            };
        }

        public string SelectedPluginVersion { get; set; }

        public IEnumerable<string> AvailablePluginVersions { get; private set; }

        public string GamePluginsJsPath
        {
            get
            {
                if (string.IsNullOrWhiteSpace(GamePath))
                    return string.Empty;
                switch (GameVersion)
                {
                    case RPGMakerVersion.MV:
                    case RPGMakerVersion.MZ:
                        return Path.Combine(GameJsPath, "plugins.js");
                    default:
                        return string.Empty;
                }
            }
        }

        public string TranslationPluginPath
        {
            get
            {
                if (string.IsNullOrWhiteSpace(GameJsPath))
                    return string.Empty;
                return Path.Combine(GameJsPath, "plugins", "JtJsonTranslationManager.js");
            }
        }

        public string TargetJsonPath
        {
            get
            {
                if (string.IsNullOrWhiteSpace(GameWwwPath))
                    return string.Empty;
                return Path.Combine(GameWwwPath, "translations.json");
            }
        }

        public string GameDataBackupZipPath
        {
            get
            {
                if (string.IsNullOrWhiteSpace(GamePath))
                    return string.Empty;
                switch (GameVersion)
                {
                    case RPGMakerVersion.MV:
                    case RPGMakerVersion.MZ:
                        return GameDataPath + ".zip";
                    default:
                        return string.Empty;
                }
            }
        }

        public string GamePluginsJsBackupPath
        {
            get
            {
                if (string.IsNullOrWhiteSpace(GamePluginsJsPath))
                    return string.Empty;
                return GamePluginsJsPath + ".zip";
            }
        }

        private bool CanAddTranslationPlugin()
        {
            return !IsRunning
                && !string.IsNullOrWhiteSpace(GamePath)
                && (GameVersion == RPGMakerVersion.MV || GameVersion == RPGMakerVersion.MZ)
                && !string.IsNullOrWhiteSpace(TranslateJsonPath)
                && File.Exists(TranslateJsonPath)
                && !string.IsNullOrWhiteSpace(GamePluginsJsPath)
                && File.Exists(GamePluginsJsPath)
                && !File.ReadAllText(GamePluginsJsPath).Contains("JtJsonTranslationManager")
                && !File.Exists(GameDataBackupZipPath) // Make sure it is not translated by TranslateViewModel
                && !File.Exists(GamePluginsJsBackupPath); // Make sure it is not translated
        }

        private void SplitDictKeyValueByRegex(Dictionary<string, string> dict, string key, Regex regex, int minLength = 0)
        {
            if (!dict.ContainsKey(key))
                return;
            string value = dict[key];
            if (regex.IsMatch(key) && regex.IsMatch(value))
            {
                var keyParts = regex.Split(key);
                var valueParts = regex.Split(value);
                if (keyParts.Length == valueParts.Length && keyParts.Length > 1)
                {
                    for (int i = 0; i < keyParts.Length; i++)
                    {
                        if (!string.IsNullOrWhiteSpace(keyParts[i]) && !string.IsNullOrWhiteSpace(valueParts[i]))
                        {
                            //if (keyParts[i].Length >= minLength && !dict.ContainsKey(keyParts[i]))
                            if (keyParts[i].Length >= minLength)
                                dict[keyParts[i]] = valueParts[i];
                        }
                    }
                }
            }
        }

        private void PreprocessJsonDictionary(Dictionary<string, string> dict)
        {
            string[] keys = dict.Keys.ToArray();
            foreach (var key in keys)
                SplitDictKeyValueByRegex(dict, key, RegexUtils.PersonNameRegex);
            keys = dict.Keys.ToArray();
            foreach (var key in keys)
                SplitDictKeyValueByRegex(dict, key, RegexUtils.EscapeRegex);
            keys = dict.Keys.ToArray();
            foreach (var key in keys)
                SplitDictKeyValueByRegex(dict, key, RegexUtils.LineBreakRegex, 3);
        }

        private async Task AddTranslationPluginAsync()
        {
            if (!CanAddTranslationPlugin())
            {
                MessageBox.Show("无法翻译，可能是因为游戏目录无效、已经翻译过或翻译文件无效", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            WeakReferenceMessenger.Default.Send(new ProgramRunningMessage(true));

            await Task.Run(async () =>
            {
                if (!File.Exists(GamePluginsJsPath))
                    return;

                // Thanks @Yricky
                // === Step 1: 备份文件 ===
                Utils.CreateZipFromFileAsync(GamePluginsJsPath, GamePluginsJsBackupPath).Wait();

                // === Step 2: 读取整个文件内容 ===
                string content = File.ReadAllText(GamePluginsJsPath);

                try{
                    var match1 = Regex.Match(content, @"(?s)var\s+\$plugins\s*=\s*(\[.*\])\s*;");
                    // full json loaded, hopefully more robust
                    if (!match1.Success)
                    {
                        MessageBox.Show("未找到 'var $plugins = [...]' 声明。", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                        return;
                    }

                    var plugins = JArray.Parse(match1.Groups[1].Value);
                    var names = plugins.Select(p => (string)p["name"]).ToHashSet();

                    if (names.Contains("JtJsonTranslationManager"))   // replacing content.Contains
                    {
                        MessageBox.Show("插件 JtJsonTranslationManager 已存在。", "提示",
                                        MessageBoxButton.OK, MessageBoxImage.Information);
                        return;
                    }

                    var match2 = Regex.Match(content, @"var\s+\$plugins\s*=\s*\[");
                    // don bother processing the remaining n writing bk tho
                    if (!match2.Success)
                    {
                        MessageBox.Show("未找到插件数组声明。", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                        return;
                    }   // ded code ig

                    string pluginText = PluginLine.Trim().TrimEnd(',');

                    string nl = content.Contains("\r\n") ? "\r\n" : "\n";
                    
                    string insertText = nl + pluginText + ",";

                    string newContent = content.Insert(match2.Index + match2.Length, insertText);

                    File.WriteAllText(GamePluginsJsPath, newContent);

                    await Utils.CopyEmbeddedFileAsync($"RPGMakerUtils.Resources.{SelectedPluginVersion}", TranslationPluginPath);

                    if (!string.IsNullOrWhiteSpace(TranslateJsonPath) && File.Exists(TranslateJsonPath))
                    {
                        var destPath = Path.Combine(GameWwwPath, "translations.json");
                        try
                        {
                            var jsonText = File.ReadAllText(TranslateJsonPath);
                            // Parse and re-serialize to remove comments and ensure valid JSON (JSON should not have comments)
                            var jsonObj = JsonConvert.DeserializeObject<Dictionary<string, string>>(jsonText);
                            if (jsonObj == null)
                            {
                                MessageBox.Show("JSON解析失败: 内容为空", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                                return;
                            }
                            PreprocessJsonDictionary(jsonObj);
                            var cleanedJson = JsonConvert.SerializeObject(jsonObj, Formatting.Indented);
                            File.WriteAllText(destPath, cleanedJson);
                        }
                        catch (Exception ex)
                        {
                            MessageBox.Show("JSON解析失败: 请确保它是一个字典" + ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                            return;
                        }
                    }

                    MessageBox.Show("已成功添加翻译插件和翻译文件。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        "修改 plugins.js 失败: " + ex.Message,
                        "错误",
                        MessageBoxButton.OK,
                        MessageBoxImage.Error
                    );
                    return;
                }
            });

            WeakReferenceMessenger.Default.Send(new ProgramRunningMessage(false));
        }

        private bool CanRestore()
        {
            return File.Exists(GamePluginsJsBackupPath)
                && !File.Exists(GameDataBackupZipPath) // Make sure it is not translated by TranslateViewModel
                && !IsRunning;
        }

        private async Task RestoreAsync()
        {
            if (!CanRestore())
            {
                MessageBox.Show("无法恢复，可能是因为没有备份文件", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            WeakReferenceMessenger.Default.Send(new ProgramRunningMessage(true));

            await Task.Run(async () =>
            {
                bool isSuccess = await Utils.ExtractZipAsync(GamePluginsJsBackupPath, Path.GetDirectoryName(GamePluginsJsPath), overwrite: true);

                Application.Current.Dispatcher.Invoke(() =>
                {
                    if (isSuccess)
                    {
                        try
                        {
                            if (File.Exists(TargetJsonPath))
                                File.Delete(TargetJsonPath);
                            if (File.Exists(TranslationPluginPath))
                                File.Delete(TranslationPluginPath);
                            if (File.Exists(GamePluginsJsBackupPath))
                                File.Delete(GamePluginsJsBackupPath);
                            MessageBox.Show("已成功恢复到未添加翻译插件的状态。", "成功", MessageBoxButton.OK, MessageBoxImage.Information);
                        }
                        catch (Exception ex)
                        {
                            MessageBox.Show("删除过程中出现错误，请手动删除文件: " + ex.Message, "错误", MessageBoxButton.OK, MessageBoxImage.Error);
                        }
                    }
                    else
                        MessageBox.Show("恢复失败，请手动解压并还原", "失败", MessageBoxButton.OK, MessageBoxImage.Error);
                });
            });

            WeakReferenceMessenger.Default.Send(new ProgramRunningMessage(false));
        }
    }
}
