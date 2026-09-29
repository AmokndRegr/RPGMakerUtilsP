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

    TranslationManager._rawDataDepth = 0;
    TranslationManager._dataFieldStates = new WeakMap();
    /*
    WeakMap<
        Object,
        Map<
            PropertyKey,{
            raw: any,
            translated: any
        }>
    >
    */

    TranslationManager._jsonExEncodingDepth = 0;

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

    TranslationManager.fetchRawData = function (callback) {
        this._rawDataDepth++;
        try {
            return callback();
        }
        finally {
            this._rawDataDepth--;
        }
    };

    TranslationManager.isRawData = function () {
        return this._rawDataDepth > 0;
    }

    TranslationManager.isJsonExEncoding = function () {
        return this._jsonExEncodingDepth > 0;
    }

    TranslationManager.bindDataField = function (target, property, options) {
        if (!target) return null;

        options = options || {};

        const key = String(property);
        let fields = this._dataFieldStates.get(target);

        if (!fields) {
            fields = new Map();
            this._dataFieldStates.set(target, fields);
        };

        var field = fields.get(key);
        if (field) {
            if (options.compareWithDatabaseRaw) {
                field.compareWithDatabaseRaw = true;
                field.databaseRaw = options.databaseRaw;
                field.databaseTranslated = options.databaseTranslated;
            }
            if (options.nullSentinel) {
                field.nullSentinel = true;
            }
            return field;
        }

        const descriptor = Object.getOwnPropertyDescriptor(target, key);

        if (!descriptor ||
            !descriptor.configurable ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value")
        ) {
            return null;
        }

        field = {
            raw: descriptor.value,
            translated: descriptor.value,

            compareWithDatabaseRaw: !!options.compareWithDatabaseRaw,
            databaseRaw: options.databaseRaw,
            databaseTranslated: options.databaseTranslated,

            //DynamicDatabase-style shadow field
            //raw===null ie. not modified, return original property()
            //return modified value otherwise
            nullSentinel: !!options.nullSentinel
        };

        fields.set(key, field);

        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: descriptor.enumerable,

            get: function () {
                if (field.nullSentinel && field.raw === null) return null;

                if (field.compareWithDatabaseRaw &&
                    field.raw !== field.databaseRaw
                ) return field.raw;

                return TranslationManager.isRawData()
                    ? field.raw
                    : field.translated;
            },

            set: function (value) {
                if (TranslationManager.isJsonExEncoding()) return;

                if (field.nullSentinel) {
                    if (value === null) {
                        field.raw = null;
                        field.translated = null;
                        //DynamicDatabase __property initialize
                    }
                    else {
                        field.raw = value;
                        field.translated = value;
                        //runtime modification wont go through translate
                    }
                    return;
                }

                if (field.compareWithDatabaseRaw) {
                    if (TranslationManager.isRawData() &&
                        value === field.raw) {
                        return;
                    }//for the JsonEx._encode in saving process
                    if (value === field.databaseRaw) {
                        field.raw = field.databaseRaw;
                        field.translated = field.databaseTranslated;
                    }//say, initializing vanilla values when loading
                    else {
                        field.raw = value;
                        field.translated = value;
                    }
                    return;
                }
                if (TranslationManager.isRawData()) {
                    field.raw = value;
                    field.translated = TranslationManager.translate(value);
                }
                else {
                    field.translated = value;
                }
            }
        });

        return field;
    };

    TranslationManager.setTranslatedData = function (target, property, value) {
        const field = this.bindDataField(target, property);

        if (field) {
            field.translated = value;
        }
        else {
            target[property] = value;
        }

        return value;
    };

    TranslationManager.setDataField = function (
        target, property, rawValue, translatedValue, options
    ) {
        const field = this.bindDataField(target, property, options);

        if (field) {
            if (options && options.nullSentinel && rawValue === null) {
                field.raw = null;
                field.translated = null;
            }
            else {
                field.raw = rawValue;
                field.translated = translatedValue;
            }

            if (options && options.compareWithDatabaseRaw) {
                field.compareWithDatabaseRaw = true;
                field.databaseRaw = options.databaseRaw;
                field.databaseTranslated = options.databaseTranslated;
            }
        }
        else {
            target[property] = translatedValue;
        }

        return translatedValue;
    };

    TranslationManager.getRawData = function (target, property) {
        const fields = target && this._dataFieldStates.get(target);
        const field = fields && fields.get(String(property));

        return field ? field.raw : target && target[property];
    };

    TranslationManager.getTranslatedData = function (target, property) {
        const fields = target && this._dataFieldStates.get(target);
        const field = fields && fields.get(String(property));

        return field ? field.translated : target && target[property];
    };

    TranslationManager.translateDataField = function (target, property) {
        const field = this.bindDataField(target, property);

        if (!field) {
            return undefined;
        }

        field.translated = this.translate(field.raw);
        return field.translated;
    };

    TranslationManager.bindDataArray = function (array) {
        if (!array) return;

        for (let i = 0; i < array.length; i++) {
            if (Object.prototype.hasOwnProperty.call(array, i)) {
                this.bindDataField(array, i);
            }
        };
    };

    TranslationManager.bindDataObject = function (object) {
        if (!object) return;

        Object.keys(object).forEach(function (key) {
            TranslationManager.bindDataField(object, key);
        });
    };

    TranslationManager.copyBoundFields = function (source, target) {
        if (!source || !target) return;

        const sourceFields = TranslationManager._dataFieldStates.get(source);
        if (!sourceFields) return;
        sourceFields.forEach(function (field, property) {
            if (!Object.prototype.hasOwnProperty.call(target, property)) return;

            const options = {};
            if (field.compareWithDatabaseRaw) {
                options.compareWithDatabaseRaw = true;
                options.databaseRaw = field.databaseRaw;
                options.databaseTranslated = field.databaseTranslated;
            }
            if (field.nullSentinel) {
                options.nullSentinel = true;
            }

            TranslationManager.setDataField(
                target,
                property,
                field.raw,
                field.translated,
                Object.keys(options).length > 0 ? options : undefined
            );
        });
    }

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
        const tField = function (object, key) {
            return TranslationManager.translateDataField(object, key);
        };

        // Translate map names in $dataMapInfos
        if ($dataMapInfos) {
            $dataMapInfos.forEach(mapInfo => {
                if (mapInfo && mapInfo.name) {
                    //mapInfo.name = TranslationManager.translate(mapInfo.name);
                    tField(mapInfo, "name");
                }
            });
        }

        // Translate Actors' names and profiles
        if ($dataActors) {
            $dataActors.forEach(actor => {
                if (!actor) return;
                //if (actor.name) actor.name = TranslationManager.translate(actor.name);
                if (actor.name) tField(actor, "name");
                //if (actor.profile) actor.profile = TranslationManager.translate(actor.profile);
                if (actor.profile) tField(actor, "profile");
                //if (actor.nickname) actor.nickname = TranslationManager.translate(actor.nickname);
                if (actor.nickname) tField(actor, "nickname");
                //if (actor.note) actor.note = TranslationManager.translate(actor.note, times = 1);
            });
        }

        // Translate Items, Skills, Weapons, Armors, States
        const dataArrays = [$dataItems, $dataSkills, $dataWeapons, $dataArmors, $dataStates];
        dataArrays.forEach(data => {
            if (data) {
                data.forEach(item => {
                    if (!item) return;
                    //if (item.name) item.name = TranslationManager.translate(item.name);
                    if (item.name) tField(item, "name");
                    //if (item.description) item.description = TranslationManager.translate(item.description);
                    if (item.description) tField(item, "description");
                    //if (item.note) item.note = TranslationManager.translate(item.note, times = 1);
                    if (item.preName) item.preName = item.name;
                    if (item.preDescription) item.preDescription = item.description; // for ItemNameEscape.js
                });
            }
        });

        // Translate Enemies
        if ($dataEnemies) {
            $dataEnemies.forEach(enemy => {
                if (!enemy) return;
                //if (enemy.name) enemy.name = TranslationManager.translate(enemy.name);
                if (enemy.name) tField(enemy, "name");
                //if (enemy.note) enemy.note = TranslationManager.translate(enemy.note, times = 1);
            });
        }

        /*
        I don want to handle all those reserved keys anymore.
        Lets see how it goes w/o this free field.
        But welp for ref:
        ConditionallyCore.js
        Pon_BattleGainVariable.js
        DynamicDatabase.js
        StatusBustImage.js
        SealActorCommand.js
        FTKR_CustomSimpleActorStatus.js
        SceneGlossary.js
        TermsOfSkillUse.js

        Also hope nobody d use TextManager.basic/param conditions in ConditionallyCore.js.
        TextManager.param[n] isnt even legal ig.
        */

        if ($dataSystem) {
            // Translate the System terms and messages
            if ($dataSystem.terms) {
                if ($dataSystem.terms.basic) {
                    TranslationManager.bindDataArray($dataSystem.terms.basic);
                    $dataSystem.terms.basic.forEach(function (_, index) {
                        tField(
                            $dataSystem.terms.basic,
                            index
                        );
                    });
                    /*
                    $dataSystem.terms.basic.forEach((term, i) => {
                        $dataSystem.terms.basic[i] = TranslationManager.translate(term);
                    });
                    */
                }
                if ($dataSystem.terms.commands) {
                    $dataSystem.terms.commands.forEach((term, i) => {
                        $dataSystem.terms.commands[i] = TranslationManager.translate(term);
                    });
                }
                if ($dataSystem.terms.params) {
                    TranslationManager.bindDataArray($dataSystem.terms.params);
                    $dataSystem.terms.params.forEach(function (_, index) {
                        tField(
                            $dataSystem.terms.params,
                            index
                        );
                    });
                    /*
                    $dataSystem.terms.params.forEach((term, i) => {
                        $dataSystem.terms.params[i] = TranslationManager.translate(term);
                    });
                    */
                }
                if ($dataSystem.terms.messages) {
                    /*
                    TranslationManager.bindDataObject($dataSystem.terms.messages);
                    Object.keys($dataSystem.terms.messages).forEach(function (key) {
                        tField(
                            $dataSystem.terms.messages,
                            key
                        );
                    });
                    */
                    for (let key in $dataSystem.terms.messages) {
                        $dataSystem.terms.messages[key] = TranslationManager.translate($dataSystem.terms.messages[key]);
                    }
                }
            }

            // Also variable and switch names
            if ($dataSystem.variables) {
                TranslationManager.bindDataArray($dataSystem.variables);
                $dataSystem.variables.forEach(function (_, index) {
                    tField(
                        $dataSystem.variables,
                        index
                    );
                });
                /*
                $dataSystem.variables.forEach((variable, i) => {
                    if (variable) {
                        $dataSystem.variables[i] = TranslationManager.translate(variable);
                    }
                });
                */
            }
            if ($dataSystem.switches) {
                TranslationManager.bindDataArray($dataSystem.switches);
                $dataSystem.switches.forEach(function (_, index) {
                    tField(
                        $dataSystem.switches,
                        index
                    );
                });
                /*
                $dataSystem.switches.forEach((sw, i) => {
                    if (sw) {
                        $dataSystem.switches[i] = TranslationManager.translate(sw);
                    }
                }
                );
                */
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

    //#region plugin patches
    function patch_JsonExStringify() {
        if (typeof JsonEx.stringify !== 'function' ||
            JsonEx._jtStringifyPatched
        ) return;

        const _JsonEx_stringify = JsonEx.stringify;
        JsonEx.stringify = function (object) {
            TranslationManager._jsonExEncodingDepth++;
            try {
                return _JsonEx_stringify.call(this, object);
            }
            finally {
                TranslationManager._jsonExEncodingDepth--;
            }
        }
        JsonEx._jtStringifyPatched = true;
    }

    function patch_JsonExMakeDeepCopy() {
        if (typeof JsonEx.makeDeepCopy !== 'function' ||
            JsonEx._jtMakeDeepCopyPatched
        ) return;

        const _JsonEx_makeDeepCopy = JsonEx.makeDeepCopy;
        JsonEx.makeDeepCopy = function (object) {
            const copy = _JsonEx_makeDeepCopy.call(this, object);

            TranslationManager.copyBoundFields(object, copy);

            return copy;
        };

        JsonEx._jtMakeDeepCopyPatched = true;
    }

    function patch_GameActorNameFields() {
        if (Game_Actor._jtNameFieldPatched) return;

        const _Game_Actor_setup = Game_Actor.prototype.setup;
        Game_Actor.prototype.setup = function (actorId) {
            _Game_Actor_setup.call(this, actorId);

            var actorData = $dataActors[actorId];
            if (!actorData) return;

            var rawName = TranslationManager.getRawData(actorData, "name");
            var translatedName = TranslationManager.getTranslatedData(actorData, "name");

            TranslationManager.setDataField(
                this,
                "_name",
                rawName,
                translatedName,
                {
                    compareWithDatabaseRaw: true,
                    databaseRaw: rawName,
                    databaseTranslated: translatedName
                }
            )
        }

        const _DataManager_extractSaveContents = DataManager.extractSaveContents;
        DataManager.extractSaveContents = function (contents) {
            _DataManager_extractSaveContents.call(this, contents);

            if (!$gameActors || !$gameActors._data || !$dataActors) return;

            const actors = $gameActors && $gameActors._data;
            if (actors) {
                actors.forEach(function (actor) {
                    if (actor) {
                        var actorData = $dataActors[actor.actorId()];
                        var savedName = actor._name;
                        var databaseRaw = TranslationManager.getRawData(actorData, "name");
                        var databaseTranslated = TranslationManager.getTranslatedData(actorData, "name");
                        if (savedName === databaseRaw) {
                            TranslationManager.setDataField(
                                actor,
                                "_name",
                                databaseRaw,
                                databaseTranslated,
                                {
                                    compareWithDatabaseRaw: true,
                                    databaseRaw: databaseRaw,
                                    databaseTranslated: databaseTranslated
                                }
                            );
                        } else {
                            TranslationManager.setDataField(
                                actor,
                                "_name",
                                savedName,
                                savedName,
                                {
                                    compareWithDatabaseRaw: true,
                                    databaseRaw: databaseRaw,
                                    databaseTranslated: databaseTranslated
                                }
                            );
                        }
                    }
                })
            }
        }

        const _DataManager_saveGame = DataManager.saveGame;
        DataManager.saveGame = function (savefileId) {
            return TranslationManager.fetchRawData(() => {
                return _DataManager_saveGame.call(this, savefileId);
            });
        }

        Game_Actor._jtNameFieldPatched = true;
    }

    function hasDynamicDatabaseActorField(property) {
        const descriptor = Object.getOwnPropertyDescriptor(Game_Actor.prototype, property);
        return !!(
            descriptor &&
            typeof descriptor.get === 'function' &&
            typeof descriptor.set === 'function' &&
            !Object.prototype.hasOwnProperty.call(descriptor, "value")
        );
    }

    function isDynamicDatabaseActor() {
        return hasDynamicDatabaseActorField('_name') &&
            hasDynamicDatabaseActorField('_nickname') &&
            hasDynamicDatabaseActorField('_profile');
    }

    function patch_DynamicDatabase_ActorFields() {
        if (!isDynamicDatabaseActor() || Game_Actor._jtDDActorFieldsPatched) return;

        const shadowFields = [
            { shadow: '__name', accessor: '_name' },
            { shadow: '__nickname', accessor: '_nickname' },
            { shadow: '__profile', accessor: '_profile' }
        ];

        const bindShadowFields = function (actor) {
            shadowFields.forEach(function (entry) {
                if (!hasDynamicDatabaseActorField(entry.accessor)) return;
                TranslationManager.bindDataField(
                    actor,
                    entry.shadow,
                    { nullSentinel: true }
                );
            });
        };

        const _Game_Actor_setup = Game_Actor.prototype.setup;
        Game_Actor.prototype.setup = function (actorId) {
            _Game_Actor_setup.call(this, actorId);
            bindShadowFields(this);
        };

        const _DataManager_extractSaveContents = DataManager.extractSaveContents;
        DataManager.extractSaveContents = function (contents) {
            _DataManager_extractSaveContents.call(this, contents);

            if (!$gameActors || !$gameActors._data) return;

            $gameActors._data.forEach(function (actor) {
                if (!actor) return;
                shadowFields.forEach(function (entry) {
                    if (!hasDynamicDatabaseActorField(entry.accessor)) return;

                    var saved = actor[entry.shadow];
                    if (saved === undefined) saved = null;
                    TranslationManager.setDataField(
                        actor,
                        entry.shadow,
                        saved,
                        saved,
                        { nullSentinel: true }
                    );
                });
            });
        };

        const _DataManager_saveGame = DataManager.saveGame;
        DataManager.saveGame = function (savefileId) {
            return TranslationManager.fetchRawData(() => {
                return _DataManager_saveGame.call(this, savefileId);
            });
        };

        Game_Actor._jtDDActorFieldsPatched = true;
    }

    function patch_DynamicDatabase_StringFields() {
        if (typeof DynamicDatabaseManager === 'undefined' ||
            typeof DynamicDatabaseManager._makePropertyString !== 'function' ||
            DynamicDatabaseManager._jtStringPropertyPatched
        ) return;

        const manager = DynamicDatabaseManager;
        const _makePropertyString = manager._makePropertyString;

        const convertEscapeCharacters = function (text) {
            if (typeof manager._convertEscapeCharacters === 'function') {
                return manager._convertEscapeCharacters(text);
            }

            if (typeof PluginManagerEx !== 'undefined' &&
                typeof PluginManagerEx.convertEscapeCharacters === 'function'
            ) {
                return PluginManagerEx.convertEscapeCharacters(text);
            }

            return text;
        };

        manager._makePropertyString = function (parent, key, child) {
            const fields = TranslationManager._dataFieldStates.get(parent);
            const field = fields && fields.get(String(key));

            //vanilla DD function for non JtJson dataField object
            if (!field) {
                return _makePropertyString.call(this, parent, key, child);
            }

            Object.defineProperty(parent, key, {
                get: function () {
                    const template = TranslationManager.isRawData()
                        ? field.raw
                        : field.translated;

                    return convertEscapeCharacters(
                        typeof template === 'string' ? template : child
                    );
                }
            });
        };

        manager._jtStringPropertyPatched = true;
    }

    //DynamicDatabase.js
    //1.3.5
    //MV
    //maybe also 2.1.4 MZ
    function patch_DynamicDatabaseComplex() {
        patch_DynamicDatabase_StringFields();

        if (isDynamicDatabaseActor()) {
            patch_DynamicDatabase_ActorFields();
        }
        else {
            patch_GameActorNameFields();
        }
    }

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
        const _notifyGainMoney = addon.notifyGainMoney;
        addon.notifyGainItem = function (item, count) {
            return TranslationManager.skipPluginTrans(() => {
                _notifyGainItem.call(this, item, count);
            })
        }

        addon.notifyGainMoney = function (value) {
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

    //PictureVariableSetting.js
    //1.5.3
    //MV
    function patch_PictureVariableSetting() {
        if (typeof Game_Interpreter.prototype.transPictureNumber !== 'function') return;
        if (Game_Interpreter._jtPictureVariableSettingPatched) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const PictureVariableSettingCommands = new Set([
            'P_VARIABLE_VALID',
            'P_VARIABLE_INVALID',
            'P_D_FILENAME',
            'P_TARGET_ALL',
            'P_TARGET_RANGE',
            'P_TARGET_MULTI',
            'P_SPIN',
            'P_SPIN_RELATIVE',
            'P_SHAKE',
            'P_STOP_SHAKE',
            'P_OUT_OF_SCREEN_SHAKE_ON',
            'P_OUT_OF_SCREEN_SHAKE_OFF'
        ])

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (PictureVariableSettingCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args)
                })
            }

            _pluginCommand.call(this, command, args)
        }

        Game_Interpreter._jtPictureVariableSettingPatched = true;
    }

    //SystemSoundCustomize.js
    //1.0.0
    //MV
    function patch_SystemSoundCustomize() {
        if (typeof Game_Interpreter.prototype.execChangeSystemSe !== 'function' ||
            typeof Game_Interpreter.prototype.execResetSystemSe !== 'function'
        ) return;
        if (Game_Interpreter._jtSystemSoundCustomizePatched) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const SystemSoundCustomizeCommands = new Set([
            'SSC_CHANGE_SYSTEM_SE',
            'SSC_システム効果音変更',
            'SSC_RESET_SYSTEM_SE',
            'SSC_システム効果音削除'
        ])

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (SystemSoundCustomizeCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                })
            }

            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtSystemSoundCustomizePatched = true;
    }

    //TF_LayeredMap.js
    //1.0.4.0
    //MV
    //Wish this plugin gud luck in terms of compatibility itself
    function patch_TF_LayeredMap() {
        if (typeof Game_Variables.prototype.valueByName !== 'function') return;
        if (Game_Variables._jtTFLayeredMapPatched) return;

        const _valueByName = Game_Variables.prototype.valueByName;
        Game_Variables.prototype.valueByName = function (name) {
            const result = TranslationManager.translate(name);
            return _valueByName.call(this, result);
        }

        Game_Variables._jtTFLayeredMapPatched = true;
    }

    //RestrictionTargetSkill.js
    //1.2.2
    //MV
    function patch_RestrictionTargetSkill() {
        if (typeof Game_BattlerBase.prototype.canSelectTarget !== 'function' ||
            typeof Game_Actor.prototype.canSelectTarget !== 'function' ||
            typeof Game_Enemy.prototype.canSelectTarget !== 'function'
        ) return;
        if (Game_BattlerBase._jtRestrictionTargetSkillPatched) return;

        const _battler = Game_BattlerBase.prototype.canSelectTarget;
        const _actor = Game_Actor.prototype.canSelectTarget;
        const _enemy = Game_Enemy.prototype.canSelectTarget;
        Game_BattlerBase.prototype.canSelectTarget = function (item, user) {
            return TranslationManager.disablePluginTrans(() => {
                return _battler.call(this, item, user);
            })
        };
        Game_Actor.prototype.canSelectTarget = function (item, user) {
            return TranslationManager.disablePluginTrans(() => {
                return _actor.call(this, item, user);
            })
        };
        Game_Enemy.prototype.canSelectTarget = function (item, user) {
            return TranslationManager.disablePluginTrans(() => {
                return _enemy.call(this, item, user);
            })
        };

        Game_BattlerBase._jtRestrictionTargetSkillPatched = true;
    }

    //SelfSwitchTemporary.js
    //2.0.1
    //MV
    //No trans needed anyway
    function patch_SelfSwitchTemporary() {
        if (typeof Game_SelfSwitches.prototype.appendTemporary !== 'function' ||
            typeof Game_SelfSwitches.prototype.clearTemporary !== 'function' ||
            typeof Game_Event.prototype.addTemporarySelfSwitch !== 'function'
        ) return;
        if (Game_SelfSwitches._jtSelfSwitchTemporaryPatched) return;

        const _add = Game_Event.prototype.addTemporarySelfSwitch;
        Game_Event.prototype.addTemporarySelfSwitch = function () {
            return TranslationManager.disablePluginTrans(() => {
                _add.call(this);
            })
        }

        Game_SelfSwitches._jtSelfSwitchTemporaryPatched = true;
    }

    //DTextPicture.js
    //1.19.0
    //MV
    //idk wheres the translateIfNeed specs at
    function patch_DTextPicture() {
        if (typeof Game_Interpreter.prototype.pluginCommandDTextPicture !== 'function') return;
        if (Game_Interpreter._jtDTextPicturePatched) return;

        var getCommandName = function (command) {
            return (command || '').toUpperCase();
        };

        const _pluginCommandDTextPicture = Game_Interpreter.prototype.pluginCommandDTextPicture;
        Game_Interpreter.prototype.pluginCommandDTextPicture = function (command, args) {
            switch (getCommandName(command)) {
                case 'D_TEXT':
                    _pluginCommandDTextPicture.call(this, command, args);
                    break;
                case 'D_TEXT_SETTING':
                case 'D_TEXT_WINDOW_CURSOR':
                case 'D_TEXT_WINDOW_CURSOR_ACTIVE':
                    return TranslationManager.disablePluginTrans(() => {
                        _pluginCommandDTextPicture.call(this, command, args);
                    });
                default:
                    _pluginCommandDTextPicture.call(this, command, args);
            }
        }

        Game_Interpreter._jtDTextPicturePatched = true;
    }

    //Chronus.js
    //1.18.0
    //MV
    function patch_Chronus() {
        if (typeof Game_Interpreter.prototype.pluginCommandChronus !== 'function') return;
        if (Game_Interpreter._jtChronusPatched) return;

        const _pluginCommandChronus = Game_Interpreter.prototype.pluginCommandChronus;
        Game_Interpreter.prototype.pluginCommandChronus = function (command, args) {
            return TranslationManager.disablePluginTrans(() => {
                _pluginCommandChronus.call(this, command, args);
            })
        }

        Game_Interpreter._jtChronusPatched = true;
    }

    //MKR_PlayerSensor.js
    //3.1.1
    //MV
    function patch_MKR_PlayerSensor() {
        if (typeof Game_Event.prototype.isFoundPlayer !== "function") return;
        if (Game_Event._jtMKR_PlayerSensorPatched) return;

        const _isFoundPlayer = Game_Event.prototype.isFoundPlayer;
        Game_Event.prototype.isFoundPlayer = function () {
            return TranslationManager.disablePluginTrans(() => {
                return _isFoundPlayer();
            })
        }

        Game_Event._jtMKR_PlayerSensorPatched = true;
    }

    //MakeScreenCapture.js
    //1.8.0
    //MV
    function patch_MakeScreenCapture() {
        if (typeof Game_Interpreter.prototype.pluginCommandMakeScreenCapture !== 'function') return;
        if (Game_Interpreter._jtMakeScreenCapture) return;

        const _pluginCommandMakeScreenCapture = Game_Interpreter.prototype.pluginCommandMakeScreenCapture;
        const _signAndSave = Bitmap.prototype.signAndSave;
        Game_Interpreter.prototype.pluginCommandMakeScreenCapture = function (command, args) {
            return TranslationManager.disablePluginTrans(() => {
                _pluginCommandMakeScreenCapture.call(this, command, args);
            })
        }
        Bitmap.prototype.signAndSave = function (signature, fileName, format, signatureImage) {
            return TranslationManager.disablePluginTrans(() => {
                _signAndSave.call(this, signature, fileName, format, signatureImage);
            })
        }
    }

    //MessageWindowPopup.js
    //2.16.3
    //MV
    //setPopupShakePosition should be fine
    function patch_MessageWindowPopup() {
        if (typeof Game_Interpreter.prototype.pluginCommandMessageWindowPopup !== 'function') return;
        if (Game_Interpreter._jtMessageWindowPopupPatched) return;

        const _pluginCommandMessageWindowPopup = Game_Interpreter.prototype.pluginCommandMessageWindowPopup;
        const _getEventIdForMessagePopup = Game_Interpreter.prototype.getEventIdForMessagePopup;
        Game_Interpreter.prototype.pluginCommandMessageWindowPopup = function (command, args) {
            return TranslationManager.disablePluginTrans(() => {
                _pluginCommandMessageWindowPopup.call(this, command, args);
            })
        }
        Game_Interpreter.prototype.getEventIdForMessagePopup = function (arg) {
            return TranslationManager.disablePluginTrans(() => {
                return _getEventIdForMessagePopup.call(this, arg);
            })
        }

        Game_Interpreter._jtMessageWindowPopupPatched = true;
    }

    //TraceEvent.js
    //1.2.0
    //MV
    function patch_TraceEvent() {
        if (typeof Game_Map.prototype.filterEventsByName !== 'function' ||
            typeof Game_Map.prototype.filterEventsByTag !== 'function'
        ) return;
        if (Game_Map._jtTraceEventPatched) return;

        const _filterByName = Game_Map.prototype.filterEventsByName;
        const _filterByTag = Game_Map.prototype.filterEventsByTag;
        Game_Map.prototype.filterEventsByName = function (name, selfEvent) {
            return TranslationManager.disablePluginTrans(() => {
                return _filterByName.call(this, name, selfEvent);
            })
        };
        Game_Map.prototype.filterEventsByTag = function (tagName, selfEvent) {
            return TranslationManager.disablePluginTrans(() => {
                return _filterByTag.call(this, tagName, selfEvent);
            })
        };
        Game_Map._jtTraceEventPatched = true;
    }

    //DynamicVariables.js
    //1.2.0
    //MV
    function patch_DynamicVariables() {
        if (typeof Game_Variables.prototype.getOriginalValue !== 'function' ||
            typeof Game_Variables.prototype.getDynamicValue !== 'function' ||
            typeof Game_Switches.prototype.getOriginalValue !== 'function' ||
            typeof Game_Switches.prototype.getDynamicValue !== 'function'
        ) return;
        if (Game_Variables._jtDynamicVariablesPatched) return;

        const _getDynamic = Game_Variables.prototype.getDynamicValue;
        const _SGetDynamic = Game_Switches.prototype.getDynamicValue;
        Game_Variables.prototype.getDynamicValue = function (dynamicScript, id, value) {
            const originalScript = TranslationManager.getRawData($dataSystem.variables, id);
            const translatedScript = TranslationManager.getTranslatedData($dataSystem.variables, id);
            if (dynamicScript === translatedScript) dynamicScript = originalScript;
            return _getDynamic.call(this, dynamicScript, id, value);
        };
        Game_Switches.prototype.getDynamicValue = function (dynamicScript, id, value) {
            const originalScript = TranslationManager.getRawData($dataSystem.switches, id);
            const translatedScript = TranslationManager.getTranslatedData($dataSystem.switches, id);
            if (dynamicScript === translatedScript) dynamicScript = originalScript;
            return _SGetDynamic.call(this, dynamicScript, id, value);
        };
        Game_Variables._jtDynamicVariablesPatched = true;
    }

    //DynamicActorGraphic.js
    //1.2.3
    //MV
    function patch_DynamicActorGraphic() {
        if (typeof Game_Actor.prototype.refreshCustomGraphic !== 'function' ||
            Game_Actor._jtDynamicActorGraphicPatched
        ) return;

        const _refresh = Game_Actor.prototype.refreshCustomGraphic;
        Game_Actor.prototype.refreshCustomGraphic = function () {
            return TranslationManager.fetchRawData(() => {
                return _refresh.call(this);
            })
        }

        Game_Actor._jtDynamicActorGraphicPatched = true;
    }

    //DynamicDatabaseNote.js
    //1.0.0
    //MV
    function patch_DynamicDatabaseNote() {
        if (typeof Game_Interpreter.prototype.changeDataNote !== 'function' ||
            Game_Interpreter._jtDynamicDatabaseNotePatched
        ) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const ddnParams = PluginManager.parameters('DynamicDatabaseNote') || {};
        const prefix = ddnParams.commandPrefix;
        const ddnCommands = new Set([
            prefix + 'メモ欄変更',
            prefix + 'CHANGE_NOTE'
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (ddnCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                });
            }
            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtDynamicDatabaseNotePatched = true;
    }

    //MoviePicture.js
    //1.8.0
    //MV
    function patch_MoviePicture() {
        if (typeof Game_Interpreter.prototype.execSetVideoPicture !== 'function' ||
            Game_Interpreter._jtMoviePicturePatched
        ) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const MPCommands = new Set([
            "MP_SET_MOVIE",
            "MP_動画設定",
            "MP_SET_LOOP",
            "MP_ループ設定",
            "MP_SET_SPEED",
            "MP_速度設定",
            "MP_SET_PAUSE",
            "MP_ポーズ設定",
            "MP_SET_WAIT",
            "MP_ウェイト設定",
            "MP_SET_LIMIT",
            "MP_リミット設定",
            "MP_SET_VOLUME",
            "MP_音量設定",
            "MP_SET_VOLUME_TYPE",
            "MP_音量種別設定",
            "MP_SET_OUTER_MOVIE",
            "MP_外部動画設定",
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (MPCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                });
            }
            _pluginCommand.call(this, command, args);
        };

        Game_Interpreter._jtMoviePicturePatched = true;
    }

    //FileDownloader.js
    //1.1.0
    //MV
    //havent seen any use case yet
    function patch_FileDownloader() {
        if (typeof Game_Interpreter.prototype.pluginCommandFileDownloader !== 'function' ||
            Game_Interpreter._jtFileDownloaderPatched
        ) return;

        const _pluginCommandDownloader = Game_Interpreter.prototype.pluginCommandFileDownloader;
        Game_Interpreter.prototype.pluginCommandFileDownloader = function (command, args) {
            return TranslationManager.disablePluginTrans(() => {
                _pluginCommandDownloader.call(this, command, args);
            });
        };

        Game_Interpreter._jtFileDownloaderPatched = true;
    }

    //StatusBustImage.js
    //1.9.0
    //MV
    function patch_StatusBustImage() {
        if (typeof Window_Base.prototype.refreshBust === 'function' &&
            !Window_Base._jtStatusBustImangePatched
        ) {
            const _refreshBust = Window_Base.prototype.refreshBust;
            Window_Base.prototype.refreshBust = function () {
                return TranslationManager.disablePluginTrans(() => {
                    return _refreshBust.call(this);
                });
            };
            Window_Base._jtStatusBustImangePatched = true;
        }

        if (typeof Game_Interpreter.prototype.pluginCommandBustStatus === 'function' &&
            !Game_Interpreter._jtStatusBustImangePatched
        ) {
            const _pluginCommandBustStatus = Game_Interpreter.prototype.pluginCommandBustStatus;
            Game_Interpreter.prototype.pluginCommandBustStatus = function (command, args) {
                return TranslationManager.disablePluginTrans(() => {
                    return _pluginCommandBustStatus.call(this, command, args);
                });
            };
            Game_Interpreter._jtStatusBustImangePatched = true;
        }
    }

    //BattleActorFaceVisibility.js
    //1.6.0
    //MV
    function patch_BattleActorFaceVisibility() {
        if (typeof Scene_Battle.prototype.createFaceWindow !== 'function' ||
            Scene_Battle._jtBattleActorFacePatched
        ) return;

        const _createFaceWindow = Scene_Battle.prototype.createFaceWindow;
        Scene_Battle.prototype.createFaceWindow = function () {
            _createFaceWindow.call(this);

            const faceWindow = this._faceWindow;
            if (!faceWindow || !faceWindow.constructor) return;

            const faceProto = faceWindow.constructor.prototype;
            if (typeof faceProto.drawActorFace !== 'function' || faceProto._jtPatched) return;

            const _drawActorFace = faceProto.drawActorFace;
            faceProto.drawActorFace = function (actor) {
                return TranslationManager.disablePluginTrans(() => {
                    return _drawActorFace.call(this, actor);
                });
            };
            faceProto._jtPatched = true;
        };
        Scene_Battle._jtBattleActorFacePatched = true;
    }

    //BattleEffectPopup.js
    //1.12.2
    //MV
    function patch_BattleEffectPopup() {
        if (typeof Game_Interpreter.prototype.pluginCommandBattleEffectPopup !== 'function' ||
            Game_Interpreter._jtBattleEffectPopupPatched
        ) return;

        const params = PluginManager.parameters('BattleEffectPopup') || {};
        const raw = (params['UsingPicture'] || params['画像使用'] || '').toUpperCase();
        const usingPicture = raw === 'ON' || raw === 'TRUE';

        //non picture mode
        if (!usingPicture) {
            Game_Interpreter._jtBattleEffectPopupPatched = true;
            return;
        }

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments)
                    });
                });
            };
        };

        Game_Interpreter.prototype.pluginCommandBattleEffectPopup = wrap(Game_Interpreter.prototype.pluginCommandBattleEffectPopup);
        Window_BattleLog.prototype.displayAddedStates = wrap(Window_BattleLog.prototype.displayAddedStates);
        Window_BattleLog.prototype.displayChangedBuffs = wrap(Window_BattleLog.prototype.displayChangedBuffs);

        Game_Interpreter._jtBattleEffectPopupPatched = true;
    }

    //PictureCallCommon.js
    //1.14.6
    //MV
    function patch_PictureCallCommon() {
        if (typeof Game_Screen.prototype.setPictureCallCommon !== 'function' ||
            Game_Interpreter._jtPictureCallCommonPatched
        ) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const PictureCallCommonCommands = new Set([
            'P_CALL_CE',
            'P_CALL_SWITCH',
            'P_CALL_KEY_BIND',
            'P_CALL_CE_REMOVE',
            'P_STROKE',
            'P_STROKE_REMOVE',
            'P_POINTER',
            'P_POINTER_REMOVE',
            'ピクチャのボタン化',
            'ピクチャのスイッチ化',
            'ピクチャのキーバインド',
            'ピクチャのボタン化解除',
            'ピクチャのなでなで設定',
            'ピクチャのなでなで解除',
            'ピクチャのポインタ化',
            'ピクチャのポインタ化解除'
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (PictureCallCommonCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                });
            }
            _pluginCommand.call(this, command, args);
        };

        Game_Interpreter._jtPictureCallCommonPatched = true;
    }

    // BattleBalloon.js
    // 1.0.0
    // MV
    function patch_BattleBalloon() {
        if (typeof Game_Interpreter.prototype.updateWaitModeForBattleBalloon !== 'function' ||
            Game_Interpreter._jtBattleBalloonPatched
        ) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const BBCommands = new Set([
            'BB_アクターにバルーン', 'BB_BALLOON_FOR_ACTOR',
            'BB_敵キャラにバルーン', 'BB_BALLOON_FOR_ENEMY',
            'BB_使用者にバルーン', 'BB_BALLOON_FOR_USER'
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (BBCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                })
            }
            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtBattleBalloonPatched = true;
    }

    // ParallelParty.js
    // 1.3.1
    // MV
    function patch_ParallelParty() {
        if (typeof Game_Interpreter.prototype.execChangeParty !== 'function' ||
            Game_Interpreter._jtParallelPartyPatched
        ) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const PPCommands = new Set([
            'PP_パーティ変更', 'PP_CHANGE_PARTY'
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (PPCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                })
            }
            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtParallelPartyPatched = true;
    }

    //SceneNumberInput.js
    //1.2.1
    //MV
    function patch_SceneNumberInput() {
        if (typeof Game_Interpreter.prototype.callNumberInput !== 'function' ||
            Game_Interpreter._jtSceneNumberInputPatched
        ) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const SNICommands = new Set([
            'SNI_CALL_NUMBER_INPUT', 'SNI_数値入力画面の呼び出し',
            'SNI_SET_NUMBER_INPUT_HELP', 'SNI_ヘルプ説明設定'
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (SNICommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                })
            }
            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtSceneNumberInputPatched = true;
    }

    //ScreenRotation.js
    //1.0.0
    //MV
    function patch_ScreenRotation() {
        if (typeof Game_Interpreter.prototype.execStartRotation !== 'function' ||
            Game_Interpreter._jtScreenRotationPatched
        ) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const SRCommands = new Set([
            'SR_回転開始', 'SR_START_ROTATION',
            'SR_回転停止', 'SR_STOP_ROTATION',
            'SR_回転リセット', 'SR_RESET_ROTATION',
            'SR_ズーム開始', 'SR_START_ZOOM'
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (SRCommands.has(String(command).toUpperCase())) {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommand.call(this, command, args);
                })
            }
            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtScreenRotationPatched = true;
    }

    //ItemCallScript.js
    //1.0.0
    //MV
    //idk what these scripts r like
    function patch_ItemCallScript() {
        if (typeof Game_Action.prototype.getItemScript !== 'function' ||
            typeof Game_Action.prototype.applyItemScript !== 'function' ||
            Game_Action._jtItemCallScriptPatched
        ) return;

        const _getItemScript = Game_Action.prototype.getItemScript;
        const _applyItemScript = Game_Action.prototype.applyItemScript;
        Game_Action.prototype.getItemScript = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _getItemScript.call(this);
                });
            });
        }
        Game_Action.prototype.applyItemScript = function (target) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _applyItemScript.call(this, target);
                });
            });
        }

        Game_Action._jtItemCallScriptPatched = true;
    }

    //AdditionalDescription.js
    //2.1.1
    //MV
    //possible script execution
    function patch_AdditionalDescription() {
        if (typeof Window_Help.prototype.setAnotherScript !== 'function' ||
            Window_Help._jtAdditionalDescriptionPatched
        ) return;

        const _setAnotherScript = Window_Help.prototype.setAnotherScript;
        Window_Help.prototype.setAnotherScript = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    _setAnotherScript.call(this);
                });
            });
        }
        Window_Help._jtAdditionalDescriptionPatched = true;
    }

    //EffectConditions.js
    //1.0.3
    //MV
    //possible script execution
    function patch_EffectConditions() {
        if (typeof Game_Action.prototype.isValidEffect !== 'function' ||
            Game_Action._jtEffectConditionsPatched
        ) return;

        const _isValidEffect = Game_Action.prototype.isValidEffect;
        Game_Action.prototype.isValidEffect = function (target, effect) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isValidEffect.call(this, target, effect);
                });
            });
        }

        Game_Action._jtEffectConditionsPatched = true;
    }

    //EventItemCondition.js
    //1.2.0
    //MV
    function patch_EventItemCondition() {
        if (typeof Window_EventItem.prototype.isOkEventItem !== 'function' ||
            Window_EventItem._jtEventItemConditionPatched
        ) return;

        const _isOkEventItem = Window_EventItem.prototype.isOkEventItem;
        Window_EventItem.prototype.isOkEventItem = function (item) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isOkEventItem.call(this, item);
                });
            });
        }

        Window_EventItem._jtEventItemConditionPatched = true;
    }

    //CursedAction.js
    //1.0.2
    //MV
    function patch_CursedAction() {
        if (typeof Game_Battler.prototype.getCursedSkillIdIfExist !== 'function' ||
            Game_Battler._jtCursedActionPatched
        ) return;

        const _getCursedSkillIdIfExist = Game_Battler.prototype.getCursedSkillIdIfExist;
        Game_Battler.prototype.getCursedSkillIdIfExist = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _getCursedSkillIdIfExist.call(this);
                });
            });
        }

        Game_Battler._jtCursedActionPatched = true;
    }

    //CounterExtend.js
    //1.10.1
    //MV
    function patch_CounterExtend() {
        if (typeof Game_BattlerBase.prototype.executeCounterScript !== 'function' ||
            typeof Game_BattlerBase.prototype.getCounterCustomRate !== 'function' ||
            Game_BattlerBase._jtCounterExtendPatched
        ) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        }

        const proto = Game_BattlerBase.prototype;
        [
            'getCounterCustomRate',
            'executeCounterScript',
            'reserveCounterSkillId',
            'getMagicCounterRate',
            'getCounterAnimationId',
            'getCrossCounterCondition',
            'eraseStateCounterFailure',
            'getCounterRate'
        ].forEach(function (name) {
            if (typeof proto[name] === 'function') {
                proto[name] = wrap(proto[name]);
            }
        });

        Game_BattlerBase._jtCounterExtendPatched = true;
    }

    //DynamicEquipParam.js
    //1.0.2
    //MV
    function patch_DynamicEquipParam() {
        if (typeof Game_Actor.prototype.paramPlusDynamic !== 'function' ||
            typeof Game_Actor.prototype.special !== 'function' ||
            Game_Actor._jtDynamicEquipParamPatched
        ) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        }

        Game_Actor.prototype.paramPlusDynamic = wrap(Game_Actor.prototype.paramPlusDynamic);
        Game_Actor.prototype.special = wrap(Game_Actor.prototype.special);

        Game_Actor._jtDynamicEquipParamPatched = true;
    }

    //SubstituteExtend.js
    //1.4.2
    //MV
    function patch_SubstituteExtend() {
        if (typeof Game_BattlerBase.prototype.isSubstituteExtend !== 'function' ||
            typeof Game_BattlerBase.prototype.getSubstituteMetaInfo !== 'function' ||
            Game_BattlerBase._jtSubstituteExtendPatched
        ) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        }

        Game_BattlerBase.prototype.isSubstituteExtend = wrap(Game_BattlerBase.prototype.isSubstituteExtend);
        Game_BattlerBase.prototype.getSubstituteMetaInfo = wrap(Game_BattlerBase.prototype.getSubstituteMetaInfo);

        Game_BattlerBase._jtSubstituteExtendPatched = true;
    }

    //SealActorCommand.js
    //1.4.0
    //MV
    function patch_SealActorCommand() {
        if (typeof Game_Actor.prototype.isSealCommand !== 'function' ||
            Game_Actor._jtSealActorCommandPatched
        ) return;

        const _isSealCommand = Game_Actor.prototype.isSealCommand;
        Game_Actor.prototype.isSealCommand = function (commandNames) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isSealCommand.call(this, commandNames);
                })
            })
        }

        Game_Actor._jtSealActorCommandPatched = true;
    }

    //VariableControlItem.js
    //1.2.0
    //MV
    function patch_VariableControlItem() {
        if (typeof Game_Action.prototype.applyVariableControl !== 'function' ||
            typeof Game_Action.prototype.isVariableControlSubject !== 'function' ||
            Game_Action._jtVariableControlItemPatched
        ) return;

        const _applyVariableControl = Game_Action.prototype.applyVariableControl;
        Game_Action.prototype.applyVariableControl = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _applyVariableControl.call(this);
                });
            });
        };
        Game_Action._jtVariableControlItemPatched = true;
    }

    // WaitInterpreterCondition.js
    // 1.0.0
    // MV
    function patch_WaitInterpreterCondition() {
        if (typeof Game_Interpreter.prototype.execWaitSwitch !== 'function' ||
            typeof Game_Interpreter.prototype.isValidWaitScript !== 'function' ||
            Game_Interpreter._jtWaitInterpreterConditionPatched
        ) return;

        const _execWaitSwitch = Game_Interpreter.prototype.execWaitSwitch;
        const _isValidWaitScript = Game_Interpreter.prototype.isValidWaitScript;
        Game_Interpreter.prototype.execWaitSwitch = function (args) {
            return TranslationManager.disablePluginTrans(() => {
                return _execWaitSwitch.call(this, args);
            });
        }
        Game_Interpreter.prototype.isValidWaitScript = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isValidWaitScript.call(this);
                });
            });
        }
        Game_Interpreter._jtWaitInterpreterConditionPatched = true;
    }

    //HitAndEvasionExtend.js
    //1.1.2
    //MV
    function patch_HitAndEvasionExtend() {
        if (Game_Action._jtHitAndEvasionExtendPatched) return;

        const params = PluginManager.parameters('HitAndEvasionExtend') || {};
        const hasFormula = ['formulaPhysicalHit', 'formulaMagicalHit', 'formulaPhysicalEvasion', 'formulaMagicalEvasion'].some(function (key) { return params[key]; });

        if (!hasFormula) {
            Game_Action._jtHitAndEvasionExtendPatched = true;
            return;
        }

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        }

        Game_Action.prototype.itemHit = wrap(Game_Action.prototype.itemHit);
        Game_Action.prototype.itemEva = wrap(Game_Action.prototype.itemEva);

        Game_Action._jtHitAndEvasionExtendPatched = true;
    }

    //SaveFileLoadOnly.js
    //1.0.0
    //MV
    function patch_SaveFileLoadOnly() {
        if (typeof Window_SavefileList.prototype.isLoadOnly !== 'function' ||
            Window_SavefileList._jtSaveFileLoadOnlyPatched
        ) return;

        const _isLoadOnly = Window_SavefileList.prototype.isLoadOnly;
        Window_SavefileList.prototype.isLoadOnly = function (fileId) {
            return TranslationManager.disablePluginTrans(() => {
                return _isLoadOnly.call(this, fileId);
            });
        }

        Window_SavefileList._jtSaveFileLoadOnlyPatched = true;
    }

    // ShakeOnDamage.js
    // 1.2.0
    // MV
    function patch_ShakeOnDamage() {
        if (typeof Game_Battler.prototype.convertShakeParameter !== 'function' ||
            Game_Battler._jtShakeOnDamagePatched
        ) return;

        const _convertShakeParameter = Game_Battler.prototype.convertShakeParameter;
        Game_Battler.prototype.convertShakeParameter = function (param) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _convertShakeParameter.call(this, param);
                })
            })
        }

        Game_Battler._jtShakeOnDamagePatched = true;
    }

    //EroStatusFix.js
    //RJ01618221
    //MZ
    //patching all those arina- slop don seem meaningful
    function patch_EroStatusFix() {
        if (typeof Scene_CustomMenu === 'undefined') return;

        const sceneProto = Scene_CustomMenu.prototype;
        const originalCreate = sceneProto._createEroVarTextWindow;

        if (typeof originalCreate !== 'function') return;
        if (sceneProto._jtEroStatusFixPatched) return;

        const patchWindowPrototype = function (windowObject) {
            if (!windowObject ||
                !windowObject.constructor ||
                !windowObject.constructor.prototype
            ) return;

            const proto = windowObject.constructor.prototype;

            if (proto._jtEroStatusDrawCategoryPatched) return;

            const originalDrawCategoryText = proto.drawCategoryText;

            if (typeof originalDrawCategoryText !== 'function') return;

            proto.drawCategoryText = function (varId, rect) {
                return TranslationManager.enableValueTrans(() => {
                    return originalDrawCategoryText.call(this, varId, rect);
                });
            };

            proto._jtEroStatusDrawCategoryPatched = true;
        };

        sceneProto._createEroVarTextWindow = function () {
            const result = TranslationManager.enableValueTrans(() => {
                return originalCreate.call(this);
            });

            const windowObject = this._eroVarTextWindow;

            patchWindowPrototype(windowObject);

            return result;
        };
        sceneProto._jtEroStatusFixPatched = true;
    }

    //StateMessageRemoveTarget.js
    //1.0.2
    //MV
    //Assumption that it wont operate on DynamicDatabase hooked object?
    function patch_StateMessageRemoveTarget() {
        if (typeof Game_Battler.prototype.hiddenNameOnlyTargetProcess !== 'function') return;
        if (Game_Battler._jtStateMessageRemoveTargetPatched) return;

        const _hideName = Game_Battler.prototype.hiddenNameOnlyTargetProcess;
        Game_Battler.prototype.hiddenNameOnlyTargetProcess = function (process) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _hideName.call(this, process);
                });
            });
        };
        Game_Battler._jtStateMessageRemoveTargetPatched = true;
    }

    //AutomaticState.js
    //1.4.4
    //MV
    function patch_AutomaticState() {
        if (typeof Game_BattlerBase.prototype.isAutomaticValid !== 'function') return;
        if (typeof Game_Actor.prototype.isAutomaticValid !== 'function') return;
        if (Game_BattlerBase._jtAutomaticStatePatched) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        }
        Game_BattlerBase.prototype.isAutomaticValid = wrap(Game_BattlerBase.prototype.isAutomaticValid);
        Game_Actor.prototype.isAutomaticValid = wrap(Game_Actor.prototype.isAutomaticValid);
        Game_BattlerBase._jtAutomaticStatePatched = true;
    }

    //CustomizeCritical.js
    //1.1.4
    //MV
    function patch_CustomizeCritical() {
        if (typeof Game_Action.prototype.judgeCritical !== 'function' ||
            typeof Window_BattleLog.prototype.showCriticalEffect !== 'function'
        ) return;
        if (Game_Action._jtCustomizeCriticalPatched) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        }
        Game_Action.prototype.evalDamageFormula = wrap(Game_Action.prototype.evalDamageFormula);
        Game_Action.prototype.judgeCritical = wrap(Game_Action.prototype.judgeCritical);
        Window_BattleLog.prototype.startAction = wrap(Window_BattleLog.prototype.startAction);
        Window_BattleLog.prototype.showCriticalEffect = wrap(Window_BattleLog.prototype.showCriticalEffect);
        Game_Action._jtCustomizeCriticalPatched = true;
    }

    //DrainExtend.js
    //1.2.0
    //MV
    function patch_DrainExtend() {
        if (typeof Game_BattlerBase.prototype.getDrainEffectiveRate !== 'function' ||
            typeof Game_Action.prototype.getDrainRate !== 'function'
        ) return;
        if (Game_BattlerBase._jtDrainExtendPatched) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        };
        Game_BattlerBase.prototype.getDrainEffectiveRate = wrap(Game_BattlerBase.prototype.getDrainEffectiveRate);
        Game_Action.prototype.getDrainRate = wrap(Game_Action.prototype.getDrainRate);
        Game_BattlerBase._jtDrainExtendPatched = true;
    }

    //EquipConditionExtend.js
    //1.1.0
    //MV
    function patch_EquipConditionExtend() {
        if (typeof Game_BattlerBase.prototype.canEquipExtend !== 'function') return;
        if (Game_BattlerBase._jtEquipConditionExtendPatched) return;

        const _canEE = Game_BattlerBase.prototype.canEquipExtend;
        Game_BattlerBase.prototype.canEquipExtend = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _canEE.apply(this, arguments);
                })
            })
        }
        Game_BattlerBase._jtEquipConditionExtendPatched = true;
    }

    //GeneralRecord.js
    //1.0.0
    //MV
    //missing CEC, just in case
    function patch_GeneralRecord() {
        if (typeof Game_Interpreter.prototype.pluginCommandGeneralRecord !== 'function') return;
        if (Game_Interpreter._jtGeneralRecordPatched) return;

        const _pluginCGR = Game_Interpreter.prototype.pluginCommandGeneralRecord;
        Game_Interpreter.prototype.pluginCommandGeneralRecord = function (command, args) {
            return TranslationManager.disablePluginTrans(() => {
                return _pluginCGR.call(this, command, args);
            });
        };
        Game_Interpreter._jtGeneralRecordPatched = true;
    }

    //GraphicalDesignMode.js
    //2.10.11
    //MV
    function patch_GraphicalDesignMode() {
        var proto = Window_Base.prototype;
        if (typeof proto.processSetProperty !== 'function' ||
            proto._jtGraphicalDesignModePatched
        ) return;

        const _CEC = proto.convertEscapeCharacters;
        const _proc = proto.processSetProperty;
        TranslationManager._jtGDMToken = false;
        proto.convertEscapeCharacters = function (text) {
            if (TranslationManager._jtGDMToken) {
                TranslationManager._jtGDMToken = false;

                return TranslationManager.disablePluginTrans(() => {
                    return _CEC.call(this, text);
                });
            }

            return _CEC.call(this, text);
        };
        proto.processSetProperty = function () {
            TranslationManager._jtGDMToken = true;
            try {
                return _proc.apply(this, arguments);
            } finally {
                TranslationManager._jtGDMToken = false;
            }
        };
        proto._jtGraphicalDesignModePatched = true;
    }

    //KillBonus.js
    //1.4.0
    //MV
    function patch_KillBonus() {
        if (typeof Game_Action.prototype.executeKillBonus !== 'function' ||
            Game_Action._jtKillBonusPatched
        ) return;

        const _executeKB = Game_Action.prototype.executeKillBonus;
        Game_Action.prototype.executeKillBonus = function (target) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _executeKB.call(this, target);
                })
            })
        };
        Game_Action._jtKillBonusPatched = true;
    }

    //MessageSkip.js
    //1.17.1
    //MV
    function patch_MessageSkip() {
        if (typeof Window_Message.prototype.initializeMessageAutoCount !== 'function' ||
            Window_Message._jtMessageSkipPatched
        ) return;

        const _initializeMAC = Window_Message.prototype.initializeMessageAutoCount;
        Window_Message.prototype.initializeMessageAutoCount = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _initializeMAC.apply(this, arguments);
                })
            })
        };
        Window_Message._jtMessageSkipPatched = true;
    }

    //ScopeExtend.js
    //1.6.1
    //MV
    function patch_ScopeExtend() {
        if (typeof Game_Action.prototype.isScopeExtendInfo !== 'function' ||
            typeof Game_Action.prototype.getScopeExtendInfo !== 'function'
        ) return;
        if (Game_Action._jtScopeExtendPatched) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.disablePluginTrans(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        Game_Action.prototype.repeatTargets = wrap(Game_Action.prototype.repeatTargets);
        Game_Action.prototype.numTargets = wrap(Game_Action.prototype.numTargets);
        Game_Action._jtScopeExtendPatched = true;
    }

    //#endregion

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
        patch_JsonExStringify();
        patch_JsonExMakeDeepCopy();
        patch_DynamicDatabaseComplex();
        patch_SceneGlossary();
        patch_TRP_CORE();
        patch_OrignalMessage();
        patch_TickerManager();
        patch_TorigoyaMZ_NotifyMessage_AddonGetItem();
        patch_TorigoyaMZ_NotifyMessage();
        patch_PictureAnimation();
        patch_SimpleVoice();
        patch_PictureVariableSetting();
        patch_SystemSoundCustomize();
        patch_TF_LayeredMap();
        patch_RestrictionTargetSkill();
        patch_SelfSwitchTemporary();
        patch_DTextPicture();
        patch_Chronus();
        patch_MKR_PlayerSensor();
        patch_MakeScreenCapture();
        patch_MessageWindowPopup();
        patch_TraceEvent();
        patch_DynamicVariables();
        patch_DynamicActorGraphic();
        patch_DynamicDatabaseNote();
        patch_MoviePicture();
        patch_FileDownloader();
        patch_StatusBustImage();
        patch_BattleActorFaceVisibility();
        patch_BattleEffectPopup();
        patch_PictureCallCommon();
        patch_BattleBalloon();
        patch_ParallelParty();
        patch_SceneNumberInput();
        patch_ScreenRotation();
        patch_ItemCallScript();
        patch_AdditionalDescription();
        patch_EffectConditions();
        patch_EventItemCondition();
        patch_CursedAction();
        patch_CounterExtend();
        patch_DynamicEquipParam();
        patch_SubstituteExtend();
        patch_SealActorCommand();
        patch_VariableControlItem();
        patch_WaitInterpreterCondition();
        patch_HitAndEvasionExtend();
        patch_SaveFileLoadOnly();
        patch_ShakeOnDamage();
        patch_EroStatusFix();
        patch_StateMessageRemoveTarget();
        patch_AutomaticState();
        patch_CustomizeCritical();
        patch_DrainExtend();
        patch_EquipConditionExtend();
        patch_GeneralRecord();
        patch_GraphicalDesignMode();
        patch_KillBonus();
        patch_MessageSkip();
        patch_ScopeExtend();
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
