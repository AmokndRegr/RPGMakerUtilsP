/*:
 * @plugindesc A plugin to translate RPG Maker game text using a JSON dictionary.
 * @author Justype
 * @version 2.3.4 Comprehensive (Broader + Faster)
 *
 * @help
 * This plugin loads a 'translations.json' file from the 'www' folder and uses it to translate various text strings in the game.
 *
 * Features:
 * - Translates menu commands, item names, skill names, actor names, map names, and more.
 * - Supports both synchronous and Promise-based translation APIs for future-proof code.
 * - Automatically applies translations after database load.
 * - Integrates with event commands and message windows.
 *
 * Usage:
 * 1. Place 'translations.json' in your project's 'www' folder. The file should map original text to translated text.
 *    Example:
 *    {
 *      "Hello, world!": "Bonjour, le monde!",
 *      "This is a test.": "Ceci est un test."
 *    }
 * 2. Add this plugin to your project and place it below any plugins that add new menu commands or text.
 * 3. Use TranslationManager in your scripts:
 *    `const translated = TranslationManager.translate("Hello");`
 * API:
 *   TranslationManager.translate(text)                // Synchronous translation
 *   TranslationManager.getTranslatePromise(text)       // Promise-based translation
 *   TranslationManager.translateIfNeed(text, callback) // Callback style
 *
 * Place this plugin below any plugins that add new menu commands or text.
 *
 * @param translationPath
 * @text Translation JSON Path
 * @desc Path to the translations.json file (relative to www folder). Example: 'data/translations.json'
 * @default translations.json
 */

(function () {
    //#region TranslationManager
    function TranslationManager() {
        throw new Error('This is a static class');
    }

    TranslationManager._dict = null;
    TranslationManager._translatedSet = new Set();
    TranslationManager._lengthKeyDict = null;

    TranslationManager._dictPath = null;
    TranslationManager._isDictChanged = false;

    TranslationManager._recentText = [];
    TranslationManager._recentMax = 4; //tweak by experience

    TranslationManager._convertedTextSet = new Set();
    TranslationManager._convertedTextQueue = [];
    TranslationManager._convertedTextMax = 128; //idk, probly not that intensive

    TranslationManager._translationDisableDepth = 0; //fully disable trans
    TranslationManager._CECDepth = 0; //enable value/variable trans
    TranslationManager._translatedSkipDepth = 0; //disable trans but retain value/variable trans

    TranslationManager.isInitialized = function () {
        return this._dict !== null;
    };

    TranslationManager.initialize = function (dictionary) {
        this._dict = dictionary;
        this._translatedSet = new Set(Object.values(dictionary));
        this._translatedSet.add(""); // Ensure empty string is included
        this._dict[""] = ""; // Ensure empty string maps to itself

        // use linebreaks to split text (Only if both key and value have same number of lines)
        for (let key in this._dict) {
            if (key.includes('\n')) {
                const value = this._dict[key];
                const keyLines = key.split('\n');
                const valueLines = value.split('\n');
                if (keyLines.length === valueLines.length) {
                    for (let i = 0; i < keyLines.length; i++) {
                        if (keyLines[i] && valueLines[i]) {
                            if (keyLines[i].length <= 3) continue; // Skip very short lines
                            const sourceLine = keyLines[i];
                            const targetLine = valueLines[i];

                            this._dict[sourceLine] = targetLine;
                            this._translatedSet.add(targetLine);

                            const normalizedSource = sourceLine.replace(/^\s+/, '');
                            const normalizedTarget = targetLine.replace(/^\s+/, '');

                            if (normalizedSource &&
                                normalizedSource !== sourceLine &&
                                !Object.prototype.hasOwnProperty.call(this._dict, normalizedSource)
                            ) {
                                this._dict[normalizedSource] = normalizedTarget;
                                this._translatedSet.add(normalizedTarget);
                            }
                        }
                    }
                }
            }
        }

        // Store keys by length for efficient partial matching
        this._lengthKeyDict = Object.keys(dictionary).reduce((acc, key) => {
            const length = key.length;
            if (!acc[length]) {
                acc[length] = [];
            }
            acc[length].push(key);
            return acc;
        }, {});
    };

    TranslationManager._inRecent = function (text) {
        return this._recentText.some(t => t.includes(text));
    };

    TranslationManager._pushRecent = function (text) {
        if (this._recentText[this._recentText.length - 1] !== text) {
            this._recentText.push(text);
            if (this._recentText.length > this._recentMax) {
                this._recentText.shift();
            }
        }
    };

    TranslationManager.isOccupied = function (occupied, start, end) {
        for (let i = start; i < end; i++) {
            if (occupied[i]) return true;
        }
        return false;
    };
    //using [) settings

    TranslationManager.getIndex = function (rawText, subString) {
        // assume its in text
        const positions = [];
        let pos = 0;
        while ((pos = rawText.indexOf(subString, pos)) !== -1) {
            positions.push(pos);
            pos += subString.length;
        }
        return positions;
    };

    TranslationManager.shouldIgnore = function (obj) {
        return (
            (typeof TRP_CORE !== "undefined" && obj === TRP_CORE)
            // || (obj.constructor.name === 'Window_MapLog')
            // || (typeof rubyBitmap !== "undefined" && obj === rubyBitmap)
        );
    };

    TranslationManager.pushConvertedText = function (text) {
        if (typeof text !== "string" || !text) return;
        if (this._convertedTextSet.has(text)) return;

        this._convertedTextSet.add(text);
        this._convertedTextQueue.push(text);

        if (this._convertedTextQueue.length > this._convertedTextMax) {
            const oldestText = this._convertedTextQueue.shift();
            this._convertedTextSet.delete(oldestText);
        }
    };

    TranslationManager.disablePluginTrans = function (callback) {
        this._translationDisableDepth++;
        try {
            return callback();
        }
        finally {
            this._translationDisableDepth--;
        }
    };

    TranslationManager.enableValueTrans = function (callback) {
        this._CECDepth++;
        try {
            return callback();
        }
        finally {
            this._CECDepth--;
        }
    };

    TranslationManager.skipPluginTrans = function (callback) {
        this._translatedSkipDepth++;
        try {
            return callback();
        }
        finally {
            this._translatedSkipDepth--;
        }
    };

    TranslationManager.translate = function (text, detectStartWhitespace = true, times = Number.POSITIVE_INFINITY, cache = true) {
        if (typeof text !== 'string' || !this._dict || this._translatedSet.has(text)) {
            return text;
        }

        if (this._convertedTextSet.has(text)) {
            this._pushRecent(text); //sweet lil Bitmap smh
            return text;
        }

        // If text can be directly translated, do it
        if (this._dict[text]) {
            this._pushRecent(this._dict[text]);
            return this._dict[text];
        }

        // If has linebreaks, translate each line separately
        if (text.includes('\n')) {
            const lines = text.split('\n');
            const translatedLines = lines.map(line => this.translate(line, detectStartWhitespace, times));
            return translatedLines.join('\n');
        }

        let leadingSpaces = null
        if (detectStartWhitespace) {
            const match = text.match(/^\s+/);
            leadingSpaces = match ? match[0] : '';
            text = text.slice(leadingSpaces.length);
        }
        if (this._translatedSet.has(text)) {
            // this._pushRecent(text); 
            // tbf im not sure abt this
            return detectStartWhitespace ? leadingSpaces + text : text;
        }
        if (this._dict[text]) {
            this._pushRecent(this._dict[text]);
            return detectStartWhitespace ? leadingSpaces + this._dict[text] : this._dict[text];
        }
        // If not in the dictionary, try to find partial matches
        let translatedText = text;
        if (this._dict && this._lengthKeyDict) {
            const textLength = text.length;
            const lenSorted = Object.keys(this._lengthKeyDict)
                .map(l => parseInt(l, 10))
                .filter(l => l < textLength)
                .sort((a, b) => b - a); // Descending order
            let freeCount = textLength;

            //occupied char record
            const occupied = new Array(textLength).fill(false);
            const result_intervals = [];
            // Go through all possible length buckets
            outer: for (let len of lenSorted) {
                for (let key of this._lengthKeyDict[len]) {
                    if (!len) {
                        break outer
                    }
                    // dict containing "":"" mapping
                    const positions = TranslationManager.getIndex(translatedText, key);
                    if (positions.length > 0) {
                        for (const start of positions) {
                            const end = start + len;
                            if (!TranslationManager.isOccupied(occupied, start, end)) {
                                result_intervals.push({
                                    start,
                                    end,
                                    replacement: this._dict[key]
                                });
                                for (let i = start; i < end; i++) {
                                    occupied[i] = 1;
                                };
                                freeCount -= len;
                            }
                            if (freeCount === 0) {
                                break outer;
                            }
                        };
                    }
                }
            }

            let result = [];
            let i = 0;
            if (result_intervals.length > 0) {
                result_intervals.sort((a, b) => a.start - b.start);
                for (const { start, end, replacement } of result_intervals) {
                    result.push(text.slice(i, start));
                    result.push(replacement);
                    i = end;
                }
            };
            result.push(text.slice(i));
            translatedText = result.join("");

            if (translatedText !== text) {
                //since cache is always enabled
                this._dict[text] = translatedText;
                if (!this._lengthKeyDict[text.length]) {
                    this._lengthKeyDict[text.length] = [];
                }
                this._lengthKeyDict[text.length].push(text);
                this._translatedSet.add(translatedText);
                translatedText = detectStartWhitespace ? leadingSpaces + translatedText : translatedText;
                this._pushRecent(translatedText);
                //recent check happens when text hasnt been processed?
            }
            else {
                this._translatedSet.add(translatedText);
                translatedText = detectStartWhitespace ? leadingSpaces + translatedText : translatedText;
            }
        }
        return translatedText;
    };

    // Async-style callback, but runs synchronously
    TranslationManager.translateIfNeed = function (text, callback) {
        const result = TranslationManager.translate(text);
        if (typeof callback === 'function') {
            callback(result);
        }
        return result;
    };

    // Returns a Promise that resolves with the translated text
    TranslationManager.getTranslatePromise = function (text) {
        return new Promise((resolve) => {
            const result = TranslationManager.translate(text);
            resolve(result);
        });
    };

    // TranslationManager.saveDictionary = function () {
    //     // Use Electron's fs module to save the updated dictionary
    //     if (!this._isDictChanged || !this._dictPath) return;
    //     this._isDictChanged = false; // Reset the flag
    //     if (typeof require !== 'function') return; // Not in an environment that supports require
    //     const fs = require('fs');
    //     if (!fs) return;

    //     let dictPath = this._dictPath;
    //     if (Utils.RPGMAKER_NAME === "MV") {
    //         dictPath = 'www/' + dictPath;
    //     }
    //     const backupDictPath = dictPath.replace(/(\.json)?$/, '_backup.json');
    //     let jsonString = JSON.stringify(this._dict, null, 2);
    //     try {
    //         fs.writeFileSync(backupDictPath, jsonString, 'utf8');
    //         if (fs.existsSync(dictPath)) {
    //             fs.unlinkSync(dictPath);
    //         }
    //         fs.renameSync(backupDictPath, dictPath);
    //     } catch (err) {
    //         console.error("Error saving file:", err);
    //         if (fs.existsSync(backupDictPath)) {
    //             fs.unlinkSync(backupDictPath);
    //         }
    //     }
    // };
    //#endregion

    //#region Data
    // TranslationManager.translateEventCommandText = function (command) {
    //     switch (command.code) {
    //         case 401: // Only one parameter which is the text
    //             command.parameters[0] = TranslationManager.translate(command.parameters[0]);
    //             break;
    //         case 102: // The first parameter is a list of choices
    //             command.parameters[0] = command.parameters[0].map(choice => TranslationManager.translate(choice));
    //             break;
    //         case 402: // second parameter is the text of the choices
    //             command.parameters[1] = TranslationManager.translate(command.parameters[1]);
    //             break;
    //         case 405: // Only one parameter (text)
    //             command.parameters[0] = TranslationManager.translate(command.parameters[0]);
    //             break;
    //         case 108: // Comment
    //         case 408: // Conditional Branch (comment)
    //             command.parameters[0] = TranslationManager.translate(command.parameters[0], detectStartWhitespace = false, times = 1);
    //             break;
    //     }
    // };

    TranslationManager.translateEventCommandComment = function (command) {
        if (command.code === 108) {
            command.parameters[0] = TranslationManager.translate(command.parameters[0], detectStartWhitespace = false, times = 1);
        }
    };

    // TranslationManager.translateEventCommandTextOld = function (command) {
    //     if ([401, 102, 402, 405].includes(command.code) && Array.isArray(command.parameters)) {
    //         command.parameters = command.parameters.map(param => {
    //             if (typeof param === 'string') {
    //                 return TranslationManager.translate(param);
    //             } else if (Array.isArray(param)) {
    //                 return param.map(p => typeof p === 'string' ? TranslationManager.translate(p) : p);
    //             }
    //             return param;
    //         });
    //     }
    // };

    TranslationManager.translateDataMap = function () {
        if ($dataMap) {
            if ($dataMap.displayName) {
                $dataMap.displayName = TranslationManager.translate($dataMap.displayName);
            }
            // if ($dataMap.events) {
            //     $dataMap.events.forEach(event => {
            //         if (event && event.pages) {
            //             event.pages.forEach(page => {
            //                 if (page.list) {
            //                     page.list.forEach(TranslationManager.translateEventCommandComment);
            //                 }
            //             });
            //         }
            //     });
            // }
        }
    };

    TranslationManager.translateCommonData = function () {
        // Translate map names in $dataMapInfos
        if ($dataMapInfos) {
            $dataMapInfos.forEach(mapInfo => {
                if (mapInfo && mapInfo.name) {
                    mapInfo.name = TranslationManager.translate(mapInfo.name);
                }
            });
        }

        // Translate Actors' names and profiles
        if ($dataActors) {
            $dataActors.forEach(actor => {
                if (!actor) return;
                if (actor.name) actor.name = TranslationManager.translate(actor.name);
                if (actor.profile) actor.profile = TranslationManager.translate(actor.profile);
                if (actor.nickname) actor.nickname = TranslationManager.translate(actor.nickname);
                if (actor.note) actor.note = TranslationManager.translate(actor.note, times = 1);
            });
        }

        // Translate Items, Skills, Weapons, Armors, States
        const dataArrays = [$dataItems, $dataSkills, $dataWeapons, $dataArmors, $dataStates];
        dataArrays.forEach(data => {
            if (data) {
                data.forEach(item => {
                    if (!item) return;
                    if (item.name) item.name = TranslationManager.translate(item.name);
                    if (item.description) item.description = TranslationManager.translate(item.description);
                    if (item.note) item.note = TranslationManager.translate(item.note, times = 1);
                    if (item.preName) item.preName = item.name;
                    if (item.preDescription) item.preDescription = item.description; // for ItemNameEscape.js
                });
            }
        });

        // Translate Enemies
        if ($dataEnemies) {
            $dataEnemies.forEach(enemy => {
                if (!enemy) return;
                if (enemy.name) enemy.name = TranslationManager.translate(enemy.name);
                if (enemy.note) enemy.note = TranslationManager.translate(enemy.note, times = 1);
            });
        }

        if ($dataSystem) {
            // Translate the System terms and messages
            if ($dataSystem.terms) {
                if ($dataSystem.terms.basic) {
                    $dataSystem.terms.basic.forEach((term, i) => {
                        $dataSystem.terms.basic[i] = TranslationManager.translate(term);
                    });
                }
                if ($dataSystem.terms.commands) {
                    $dataSystem.terms.commands.forEach((term, i) => {
                        $dataSystem.terms.commands[i] = TranslationManager.translate(term);
                    });
                }
                if ($dataSystem.terms.params) {
                    $dataSystem.terms.params.forEach((term, i) => {
                        $dataSystem.terms.params[i] = TranslationManager.translate(term);
                    });
                }
                if ($dataSystem.terms.messages) {
                    for (let key in $dataSystem.terms.messages) {
                        $dataSystem.terms.messages[key] = TranslationManager.translate($dataSystem.terms.messages[key]);
                    }
                }
            }

            // Also variable and switch names
            if ($dataSystem.variables) {
                $dataSystem.variables.forEach((variable, i) => {
                    if (variable) {
                        $dataSystem.variables[i] = TranslationManager.translate(variable);
                    }
                });
            }
            if ($dataSystem.switches) {
                $dataSystem.switches.forEach((sw, i) => {
                    if (sw) {
                        $dataSystem.switches[i] = TranslationManager.translate(sw);
                    }
                }
                );
            }

            // Translate game title
            if ($dataSystem.gameTitle) {
                $dataSystem.gameTitle = TranslationManager.translate($dataSystem.gameTitle);
            }
        }

        // // Translate event text and choices in common events
        // if ($dataCommonEvents) {
        //     $dataCommonEvents.forEach(event => {
        //         if (event && event.list) {
        //             event.list.forEach(TranslationManager.translateEventCommandComment);
        //         }
        //     });
        // }
    };
    //#endregion

    //SceneGlossary.js 
    //2.15.0 
    //MV
    function patch_SceneGlossary() {
        if (typeof Window_Glossary === 'undefined') return;
        if (Window_Glossary.prototype._jtPatched) return;
        Window_Glossary.prototype._jtPatched = true;

        const _getPictureName = Window_Glossary.prototype.getPictureName;
        if (typeof _getPictureName === "function") {
            Window_Glossary.prototype.getPictureName = function (index) {
                return TranslationManager.disablePluginTrans(() => {
                    return _getPictureName.call(this, index);
                })
            }
        }

        const _getPlusPictureData = Window_Glossary.prototype.getPlusPictureData;
        if (typeof _getPlusPictureData === "function") {
            Window_Glossary.prototype.getPlusPictureData = function (imageIndex, index) {
                return TranslationManager.disablePluginTrans(() => {
                    return _getPlusPictureData.call(this, imageIndex, index);
                })
            }
        }
    };

    //TRP_CORE.js
    //1.28
    //MZ
    //actually registered in TRP_SkitMZ.js 1.22
    function patch_TRP_CORE() {
        if (typeof TRP_CORE === "undefined") return;
        if (TRP_CORE._jtPatched) return;

        const _convertEscapeCharacters = TRP_CORE.convertEscapeCharacters;
        if (typeof _convertEscapeCharacters !== "function") return;
        TRP_CORE._jtPatched = true;
        //postpone cuz CEC is not compulsory
        //only once tho?

        TRP_CORE.convertEscapeCharacters = function (text) {
            return TranslationManager.disablePluginTrans(() => {
                return _convertEscapeCharacters.call(this, text);
            })
        }
    }

    //OriginalMessage.js
    //MV
    //RJ01676425 initial release
    //tf zero metadata
    function patch_OrignalMessage() {
        if (typeof Game_Screen.prototype.OriginalMessage !== "function") return;
        if (Game_Screen._jtOriginalMessagePatched) return;
        Game_Screen._jtOriginalMessagePatched = true;

        const _OriginalMessage = Game_Screen.prototype.OriginalMessage;

        Game_Screen.prototype.OriginalMessage = function (name, message, type, position) {
            name = TranslationManager.translate(name);
            message = TranslationManager.translate(message);

            const messageText = $gameMessage && $gameMessage._texts; //return left most falsy operand? wat?!
            const oriLength = messageText ? messageText.length : 0;

            _OriginalMessage.call(this, name, message, type, position);

            if (messageText) {
                for (let i = oriLength; i < messageText.length; i++) {
                    TranslationManager.pushConvertedText(messageText[i])  //tha large window is surprisingly useful
                }
            }

        };
    }

    //CompositeLimit.js
    //MV
    //RJ01676425 initial release
    //obfuscated plugin, hope its how it works :/
    function patch_TickerManager() {
        if (typeof TickerManager === 'undefined') return;
        if (TickerManager._jtPatched === true) return;

        const _show = TickerManager.show;
        if (typeof _show === 'function') {
            TickerManager.show = function (text) {
                _show.call(this, TranslationManager.translate(text));
            }
        }

        TickerManager._jtPatched = true;
    }

    //TorigoyaMZ_NotifyMessage.js
    //1.6.2
    //MZ
    //not rlly necessary, take it as a showcase xd
    function patch_TorigoyaMZ_NotifyMessage() {
        const manager = window.Torigoya && window.Torigoya.NotifyMessage
            ? window.Torigoya.NotifyMessage.Manager
            : null;
        if (!manager || manager._jtPatched) return;

        const _setupWindow = manager._setupWindow;
        if (typeof _setupWindow !== 'function') return;

        manager._setupWindow = function (notifyItem) {
            if (notifyItem &&
                typeof notifyItem.message === 'string' &&
                TranslationManager._translatedSkipDepth === 0 &&
                !notifyItem._jtMessageTranslated
            ) {
                notifyItem.message = TranslationManager.translate(notifyItem.message);
                notifyItem._jtMessageTranslated = true;
            }

            return TranslationManager.skipPluginTrans(() => {
                return _setupWindow.call(this, notifyItem);
            })
        }

        manager._jtPatched = true;
    }

    //TorigoyaMZ_NotifyMessage_AddonGetItem.js
    //1.3.0
    //MZ
    function patch_TorigoyaMZ_NotifyMessage_AddonGetItem() {
        const addon = window.Torigoya && window.Torigoya.NotifyMessage && window.Torigoya.NotifyMessage.Addons
            ? window.Torigoya.NotifyMessage.Addons.GetItem
            : null;
        if (!addon || !addon.parameter || addon._jtPatched) return;
        //plugin itself is kinda weird

        const parameter = addon.parameter;
        parameter.baseGainSingleMessage = TranslationManager.translate(parameter.baseGainSingleMessage);
        parameter.baseGainMultiMessage = TranslationManager.translate(parameter.baseGainMultiMessage);
        parameter.baseGainMoneyMessage = TranslationManager.translate(parameter.baseGainMoneyMessage);

        const _notifyGainItem = addon.notifyGainItem;
        addon.notifyGainItem = function (item, count) {
            return TranslationManager.skipPluginTrans(() => {
                _notifyGainItem.call(this, item, count);
            })
        }

        const _notifyGainMoney = function (value) {
            return TranslationManager.skipPluginTrans(() => {
                _notifyGainMoney.call(this, value);
            })
        }

        addon._jtPatched = true;
    }

    //PictureAnimation.js
    //1.6.1
    //MV
    function patch_PictureAnimation() {
        if (typeof Game_Interpreter.prototype.pluginCommandPictureAnimation !== 'function') return;
        if (Game_Interpreter._jtPictureAnimationPatched === true) return;

        const _pluginCommandPictureAnimation = Game_Interpreter.prototype.pluginCommandPictureAnimation;
        Game_Interpreter.prototype.pluginCommandPictureAnimation = function (command, args) {
            return TranslationManager.disablePluginTrans(() => {
                _pluginCommandPictureAnimation.call(this, command, args)
            })
        }

        Game_Interpreter._jtPictureAnimationPatched = true;
    }

    //SimpleVoice.js
    //1.3.0
    //MV
    //Maybe we need a plugin builder rn...
    function patch_SimpleVoice() {
        if (typeof Game_Interpreter.prototype.execPlayVoice !== 'function') return;
        if (Game_Interpreter._jtSimpleVoicePatched) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const simpleVoiceCommands = new Set([
            'SV_ボイスの演奏',
            'SV_PLAY_VOICE',
            'SV_ボイスのループ演奏',
            'SV_PLAY_LOOP_VOICE',
            'SV_ボイスの停止',
            'SV_STOP_VOICE',
            'SV_ボイスの演奏の予約',
            'SV_RESERVE_VOICE',
            'SV_ボイスのループ演奏の予約',
            'SV_RESERVE_LOOP_VOICE'
        ].map(command => command.toUpperCase()));

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (simpleVoiceCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                })
            }

            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtSimpleVoicePatched = true;
    }

    //#region Plugin
    function patchPlugin() {
        // TextResource (RPG Maker MZ)
        if (typeof TextResource !== 'undefined' && TextResource.getText) {
            const _TextResource_getText = TextResource.getText;
            TextResource.getText = function (label) {
                const text = _TextResource_getText.call(this, label);
                return TranslationManager.translate(text);
            };
        }
        patch_SceneGlossary();
        patch_TRP_CORE();
        patch_OrignalMessage();
        patch_TickerManager();
        patch_TorigoyaMZ_NotifyMessage_AddonGetItem();
        patch_TorigoyaMZ_NotifyMessage();
        patch_PictureAnimation();
        patch_SimpleVoice();
    };
    //#endregion

    function registerSGCategoryTrans() {
        if (!TranslationManager._dict || !TranslationManager._lengthKeyDict) return;

        const registered = new Set();

        const hasOwn = function (object, key) {
            return Object.prototype.hasOwnProperty.call(object, key);
        }

        const addTrans = function (source, target) {
            if (!source || !target || hasOwn(TranslationManager._dict, source)) return;

            TranslationManager._dict[source] = target;

            if (!TranslationManager._lengthKeyDict[source.length]) {
                TranslationManager._lengthKeyDict[source.length] = [];
            }

            if (!TranslationManager._lengthKeyDict[source.length].includes(source)) {
                TranslationManager._lengthKeyDict[source.length].push(source);
            }

            TranslationManager._translatedSet.add(target);
        };

        const getValueParts = function (value, expectedLength) {
            const delimiters = [',', '，'];

            for (const delimiter of delimiters) {
                if (!value.includes(delimiter)) continue;

                const parts = value.split(delimiter);

                if (parts.length === expectedLength && parts.every(function (part) { return part.length > 0; })) {
                    return parts;
                }
            }

            //non dividable fallback
            return expectedLength === 1 && value.length > 0 ? [value] : null
        }

        const getSGCategory = function (item) {
            if (!item || !item.meta) return undefined;
            if (hasOwn(item.meta, 'SGカテゴリ')) return item.meta.SGカテゴリ;
            if (hasOwn(item.meta, 'SGCategory')) return item.meta.SGCategory;
            return undefined;
        }

        if (!$dataItems || !Array.isArray($dataItems)) return;

        $dataItems.forEach(function (item) {
            const sourceComb = getSGCategory(item);

            if (sourceComb === undefined || sourceComb === null || sourceComb === '' || registered.has(sourceComb)) return;

            registered.add(sourceComb);

            const translatedComb = TranslationManager._dict[sourceComb];

            if (!translatedComb) return;

            const sourceParts = sourceComb.split(',');
            const translatedParts = getValueParts(translatedComb, sourceParts.length);

            if (!translatedParts) return;

            sourceParts.forEach(function (sourcePart, index) {
                const translatedPart = translatedParts[index];

                if (!sourcePart || !translatedPart) return;

                addTrans(sourcePart, translatedPart);
            })
        })
    };

    //#region Initialization
    // --- Core Logic: Load the Translation Dictionary ---
    // This function is aliased to load our custom data before the game starts.
    const _DataManager_loadDatabase = DataManager.loadDatabase;
    DataManager.loadDatabase = function () {
        _DataManager_loadDatabase.call(this);
        // Get plugin parameters
        let parameters = PluginManager.parameters('JtJsonTranslationManager');
        let translationPath = parameters['translationPath'] || 'translations.json';
        TranslationManager._dictPath = translationPath;
        const xhr = new XMLHttpRequest();
        const url = translationPath;
        xhr.open('GET', url, false);
        xhr.overrideMimeType('application/json');
        xhr.onload = function () {
            if (xhr.status < 400) {
                TranslationManager.initialize(JSON.parse(xhr.responseText));
            }
        };
        xhr.onerror = function () {
            throw new Error('Failed to load ' + url);
        };
        xhr.send();
    };

    // Patch DataManager.onLoad to run translation after all database files are loaded
    const _DataManager_onLoad = DataManager.onLoad;
    DataManager._translationApplied = false;
    DataManager.onLoad = function (object) {
        _DataManager_onLoad.call(this, object);
        if (DataManager.isDatabaseLoaded() && !DataManager._translationApplied && TranslationManager.isInitialized()) {
            registerSGCategoryTrans();
            TranslationManager.translateCommonData();
            patchPlugin();
            DataManager._translationApplied = true;
        }

        // Translate map data when it's loaded
        if (object === $dataMap && TranslationManager.isInitialized()) {
            TranslationManager.translateDataMap();
        }

        // TranslationManager.saveDictionary();
    };

    window.TranslationManager = TranslationManager;
    //#endregion

    //#region Patches
    // Choices and other command window text
    const _Window_Command_addCommand = Window_Command.prototype.addCommand;
    Window_Command.prototype.addCommand = function (name, symbol, enabled = true, ext = null) {
        _Window_Command_addCommand.call(this, TranslationManager.translate(name), symbol, enabled, ext);
    };

    // Message window text
    // Going through CEC anyway so obsolete ig?
    /*
    const _Window_Message_startMessage = Window_Message.prototype.startMessage;
    Window_Message.prototype.startMessage = function () {
        for (let i = 0; i < $gameMessage._texts.length; i++) {
            $gameMessage._texts[i] = TranslationManager.translate($gameMessage._texts[i]);
        }
        _Window_Message_startMessage.call(this);
    };
    */

    // Battle log text ??
    const _Window_BattleLog_addText = Window_BattleLog.prototype.addText;
    Window_BattleLog.prototype.addText = function (text) {
        _Window_BattleLog_addText.call(this, TranslationManager.translate(text));
    };

    // Thanks to the improvement in translate function, this is be acceptable now.
    // Window_Base.drawText is implemented in terms of Bitmap.drawText, so patching Bitmap.drawText should cover most cases.
    const _Bitmap_drawText = Bitmap.prototype.drawText;
    Bitmap.prototype.drawText = function (text, x, y, maxWidth, lineHeight, align) {
        if (TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) {
            return _Bitmap_drawText.call(this, text, x, y, maxWidth, lineHeight, align);
        }
        if (typeof (text) === 'string') {
            if (TranslationManager._inRecent(text)) {
                return _Bitmap_drawText.call(this, text, x, y, maxWidth, lineHeight, align);
            }
            return _Bitmap_drawText.call(this, TranslationManager.translate(text), x, y, maxWidth, lineHeight, align);
        }
        else {
            return _Bitmap_drawText.call(this, text, x, y, maxWidth, lineHeight, align);
        }
    };

    const _Bitmap_measureTextWidth = Bitmap.prototype.measureTextWidth;
    Bitmap.prototype.measureTextWidth = function (text) {
        if (TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) {
            return _Bitmap_measureTextWidth.call(this, text);
        }
        if (typeof (text) === 'string') {
            if (TranslationManager._inRecent(text)) {
                return _Bitmap_measureTextWidth.call(this, text);
            }
            return _Bitmap_measureTextWidth.call(this, TranslationManager.translate(text));
        } else {
            return _Bitmap_measureTextWidth.call(this, text);
        }
    };

    // const _Window_Base_drawText = Window_Base.prototype.drawText;
    // Window_Base.prototype.drawText = function (text, x, y, maxWidth, align) {
    //     if (text) {
    //         return _Window_Base_drawText.call(this, TranslationManager.translate(text), x, y, maxWidth, align);
    //     } else {
    //         return _Window_Base_drawText.call(this, text, x, y, maxWidth, align);
    //     }
    // };

    // // Alias the function that draws text in most windows
    // // This provides broad coverage for things like item descriptions, skill names, etc.
    // // drawTextEx will call convertEscapeCharacters, so we only need to patch one of them.
    // const _Window_Base_drawTextEx = Window_Base.prototype.drawTextEx;
    // Window_Base.prototype.drawTextEx = function(text, x, y) {
    //     if (text) {
    //         return _Window_Base_drawTextEx.call(this, TranslationManager.translate(text), x, y);
    //     } else {
    //         return _Window_Base_drawTextEx.call(this, text, x, y);
    //     }
    // };

    //Base game function, it should be fine placed here?
    const _Game_Variables_value = Game_Variables.prototype.value;
    Game_Variables.prototype.value = function (variableId) {
        const value = _Game_Variables_value.call(this, variableId);
        if (TranslationManager._CECDepth > 0 && typeof value === 'string') { return TranslationManager.translate(value); };
        return value;
    };

    const _Window_Base_convertEscapeCharacters = Window_Base.prototype.convertEscapeCharacters;
    Window_Base.prototype.convertEscapeCharacters = function (text) {
        if (TranslationManager._translationDisableDepth > 0) {
            return _Window_Base_convertEscapeCharacters.call(this, text);
        };
        /*
        if (TranslationManager.shouldIgnore(this)) {
            return _Window_Base_convertEscapeCharacters.call(this, text);
        }
        */
        if (TranslationManager._translatedSkipDepth > 0) {
            return TranslationManager.enableValueTrans(() => {
                const result = _Window_Base_convertEscapeCharacters.call(this, text);
                if (result !== text) {
                    TranslationManager.pushConvertedText(result);
                    //for general usage d better push it ig?
                    //but this ones under logic of 'do it since its expanding variables'
                    //does it apply to the lower one tho
                }
                return result;
            });
        };
        return TranslationManager.enableValueTrans(() => {
            const result = TranslationManager.translate(text);
            const converted = _Window_Base_convertEscapeCharacters.call(this, result);
            if (result !== text) TranslationManager.pushConvertedText(converted);
            return converted;
        });
    };
    //#endregion
})();
