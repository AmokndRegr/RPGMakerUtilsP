/*:
 * @plugindesc A plugin to translate RPG Maker game text using a JSON dictionary.
 * @author Justype
 * @upstream version 2.3.4 Comprehensive (Broader + Faster)
 * @patch ver 0.16.10.2 kido plugins support
 *        ver 0.15.10.24 newrpg(NRP) plugins primary support
 *        ver 0.14.10.3 Estriole(EST) plugins primary support
 *        ver 0.13.10.6 Galv plugins primary support
 *        ver 0.12.05.10 VisuStella MZ plugins limited support
 *        ver 0.11.10.6 Lulu's Church(LL) plugins primary support
 *        ver 0.10.05.8 NUUN plugins essential support, paywalled instances omitted
 *        ver 0.9.10.5 Torigoya plugins primary support
 *        ver 0.8.10.14 DarkPlasma plugins primary support
 *        ver 0.7.05.32 FTKR MV plugins support
 *        ver 0.6.05.16 YEP MV plugins support
 *        ver 0.5.05.5 tomoaky(TM) MV plugins support
 *        ver 0.4.10.11 MOG plugins primary support
 *        ver 0.3.10.2 MKR plugins primary support
 *        ver 0.2.10.5 munokura(MNKR) plugins primary support
 *        ver 0.1.10.0 triacontane plugins primary support
 * @memo    1. Game_Message.newPage rarely used, discard.
 *          2. WishListForFusionItem n NotifyWishList from DarkPlasma may need rework after Torigoya patch.
 *          3. Window_Command.prototype.addCommand trans disabled, old patches review needed.
 *          4. SimpleMsgSideViewMZ related override
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

    TranslationManager._rawDataDepth = 0; //dynamic object raw value switch
    TranslationManager._dataFieldStates = new WeakMap();
    TranslationManager._descriptionTemplateStates = new WeakMap();
    TranslationManager._descriptionTemplateTransDepth = 0;
    /*
    WeakMap<
        Object,
        Map<
            PropertyKey,
            {
            raw: any, 
            translated: any, 
            getter: function, 

            //runtime object, eg. $gameActor
            compareWithDatabaseRaw: boolean,
            databaseRaw: any,
            databaseTranslated

            //used by DynamicDatabase __property
            nullSentinel: boolean
            }

            //derived field for DescriptionTemplate
            {
            readRaw: function,
            readTranslated: function,
            getter: function,

            //the upper structure of the object be4 derived field attaching
            valueField?: valueFieldState 
            }
        >
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

    TranslationManager.getIndex = function (rawText, subString, overlapping = false) {
        // assume its in text
        const positions = [];
        let pos = 0;
        while ((pos = rawText.indexOf(subString, pos)) !== -1) {
            positions.push(pos);
            pos += overlapping ? 1 : subString.length;
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

    // tell if the property of target is still that one bond by JtJson proc chain
    TranslationManager.getDataFieldState = function (target, property) {
        const fields = target && this._dataFieldStates.get(target);
        const field = fields && fields.get(String(property));
        const descriptor = target && Object.getOwnPropertyDescriptor(target, property);
        return field && descriptor && descriptor.get === field.getter ? field : null;
    }

    //temporily disable rawDataDepth
    TranslationManager.fetchTranslatedData = function (callback) {
        const depth = this._rawDataDepth;
        this._rawDataDepth = 0;
        try {
            return callback();
        }
        finally {
            this._rawDataDepth = depth;
        }
    };

    //Derived fields keeps the original setter (n its absence), enumerability and lifetime.
    //valueField is optional, preset only for a JtJson bounded property.
    //No re-enter override yet.
    TranslationManager.bindDerivedDataField = function (target, property, readRaw, readTranslated, valueField) {
        if (!target) return null;

        const descriptor = Object.getOwnPropertyDescriptor(target, property);
        if (!descriptor || !descriptor.configurable) return null;

        let fields = this._dataFieldStates.get(target);
        if (!fields) {
            fields = new Map();
            this._dataFieldStates.set(target, fields);
        }

        const field = {
            readRaw: readRaw,
            readTranslated: readTranslated,
            valueField: valueField
        };
        field.getter = function () {
            return TranslationManager.isRawData()
                ? field.readRaw.call(this)
                : field.readTranslated.call(this);
        };
        Object.defineProperty(target, property, {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: field.getter,
            set: descriptor.set
        });
        fields.set(String(property), field);
        return field;
    };

    TranslationManager.bindDataField = function (target, property, options) {
        if (!target) return null;

        options = options || {};

        const key = String(property);
        let fields = this._dataFieldStates.get(target);

        if (!fields) {
            fields = new Map();
            this._dataFieldStates.set(target, fields);
        };

        var field = this.getDataFieldState(target, key);
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

        field.getter = Object.getOwnPropertyDescriptor(target, key).get;

        return field;
    };

    TranslationManager.setTranslatedData = function (target, property, value) {
        const bound = this.bindDataField(target, property);
        const field = bound && (bound.valueField || bound); //get valueField when available

        //bonded dynamic field write
        if (field && !field.readRaw) {
            field.translated = value;
        }
        else {
            target[property] = value;
        }
        //non bonded property or derived field w/o valueField

        return value;
    };

    TranslationManager.setDataField = function (
        target, property, rawValue, translatedValue, options
    ) {
        const bound = this.bindDataField(target, property, options);
        const field = bound && (bound.valueField || bound);

        if (field && !field.readRaw) {
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

    //get vanilla value as if JtJson not installed
    TranslationManager.getRawData = function (target, property) {
        const field = this.getDataFieldState(target, property);
        return field && !field.readRaw ? field.raw : this.fetchRawData(function () {
            return target && target[property];
        });
    };

    TranslationManager.getTranslatedData = function (target, property) {
        const field = this.getDataFieldState(target, property);
        return field && !field.readRaw ? field.translated : this.fetchTranslatedData(function () {
            return target && target[property];
        });
    };

    TranslationManager.translateDataField = function (target, property) {
        const field = this.bindDataField(target, property);

        if (!field) {
            return undefined;
        }

        //derived field don need a second trans seq
        if (field.readRaw) return this.getTranslatedData(target, property);

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

            //don handle override property since its never specified as this line put
            if (TranslationManager.getDataFieldState(source, property) !== field) return;
            //vanilla dynamic logic d get lost as well
            if (field.readRaw) {
                TranslationManager.setDataField(
                    target, property,
                    TranslationManager.getRawData(source, property),
                    TranslationManager.getTranslatedData(source, property)
                );
                return;
            }

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

    function normalizeMask(mask, textLength) {
        if (mask == null) return [];
        if (!Array.isArray(mask)) return [];
        const ranges = [];
        for (const range of mask) {
            const start = range[0];
            const end = range[1];
            if (start < 0 || end < start || end > textLength) continue;
            if (start !== end) ranges.push([start, end]);
        }
        ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const merged = [];
        for (const range of ranges) {
            const last = merged[merged.length - 1];
            if (last && range[0] <= last[1]) {
                last[1] = Math.max(last[1], range[1]);
            }
            else {
                merged.push(range);
            }
        }
        return merged;
    }

    TranslationManager.translate = function (text, detectStartWhitespace = true, times = Number.POSITIVE_INFINITY, cache = true, mask = null) {
        if (typeof text !== 'string' || !this._dict) {
            return text;
        }
        const ranges = normalizeMask(mask, text.length);
        const hasMask = ranges.length > 0;
        if (this._translatedSet.has(text)) {
            if (hasMask) {
                this._pushRecent(text); //needs verification ig
            }
            return text;
        }

        if (this._convertedTextSet.has(text)) {
            this._pushRecent(text); //sweet lil Bitmap smh
            return text;
        }

        // If text can be directly translated, do it
        if (!hasMask && this._dict[text]) {
            this._pushRecent(this._dict[text]);
            return this._dict[text];
        }

        // If has linebreaks, translate each line separately
        if (!hasMask && text.includes('\n')) {
            const lines = text.split('\n');
            const translatedLines = lines.map(line => this.translate(line, detectStartWhitespace, times));
            const translatedText = translatedLines.join('\n');
            this._translatedSet.add(translatedText);
            return translatedText;
            //rlly necessary tho?
        }

        let leadingSpaces = '';
        if (!hasMask && detectStartWhitespace) {
            const match = text.match(/^\s+/);
            leadingSpaces = match ? match[0] : '';
            text = text.slice(leadingSpaces.length);
        }
        if (this._translatedSet.has(text)) {
            // this._pushRecent(text); 
            // tbf im not sure abt this
            return detectStartWhitespace ? leadingSpaces + text : text;
        }
        if (!hasMask && this._dict[text]) {
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
            function occupy(start, end) {
                for (let index = start; index < end; index++) {
                    if (!occupied[index]) {
                        occupied[index] = true;
                        freeCount--;
                    }
                }
            }
            for (const range of ranges) {
                occupy(range[0], range[1]);
            }

            //DynamicTemplate keys preservation
            if (this._descriptionTemplateTransDepth > 0) {
                const placeholders = /\$\{(.*?)}/g;
                let placeholder;
                while ((placeholder = placeholders.exec(text))) {
                    occupy(placeholder.index, placeholders.lastIndex);
                }
            }

            const result_intervals = [];
            // Go through all possible length buckets
            outer: for (let len of lenSorted) {
                if (freeCount === 0) break outer;
                for (let key of this._lengthKeyDict[len]) {
                    if (!len) {
                        break outer
                    }
                    // dict containing "":"" mapping
                    const positions = TranslationManager.getIndex(translatedText, key, hasMask);
                    if (positions.length > 0) {
                        for (const start of positions) {
                            const end = start + len;
                            if (!TranslationManager.isOccupied(occupied, start, end)) {
                                result_intervals.push({
                                    start,
                                    end,
                                    replacement: this._dict[key]
                                });
                                occupy(start, end);
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
                if (!hasMask || !this._lengthKeyDict[text.length].includes(text)) {
                    this._lengthKeyDict[text.length].push(text);
                }
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
                TranslationManager.translateDataField($dataMap, 'displayName');
                //$dataMap.displayName = TranslationManager.translate($dataMap.displayName);
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

    //pass in an object n its description before possible DT bonding
    //mirroring applyDescriptionTemplate@DescriptionTemplate.js gating
    //n its description has to be getter
    function observeDescriptionTemplates(object, previousDescriptions) {
        if (!previousDescriptions || typeof DataManager.findTemplate !== 'function') return;
        const templates = DataManager.findTemplate(object);
        if (!templates) return;

        object.forEach(function (data, index) {
            if (!data || previousDescriptions[index] || !data.meta || data.meta.NoDescTemplate) return;

            const descriptor = Object.getOwnPropertyDescriptor(data, 'description');

            const templateIndex = parseInt(data.meta.TemplateIndex) - 1;
            const template = templates[templateIndex || 0];
            if (!template ||
                typeof template !== 'string' ||
                !descriptor ||
                typeof descriptor.get !== 'function' ||
                !data.hasOwnProperty('prevDesc')) return;

            TranslationManager._descriptionTemplateStates.set(
                data,
                {
                    template: template,
                    nativeGetter: descriptor.get
                }
            );
        });
    }

    //mirroring createDescription@DescriptionTemplate.js
    function createTranslatedDescription(data, template) {

        const textValue = function (owner, key, convertLabel) {
            const value = owner[key];
            let result = value;

            let bound = TranslationManager.getDataFieldState(owner, key);

            if (convertLabel) {
                const label = DataManager.findOptionLabel(key, value);
                if (label) {
                    result = label;
                    const params = PluginManager.parameters('DescriptionTemplate');
                    const terms = params.terms || {};
                    const option = DataManager._optionLabels && DataManager._optionLabels.get(key);
                    if (value === -1 && key === 'elementId') {
                        bound = TranslationManager.getDataFieldState(terms, 'normalAttack');
                    }
                    else if (option && option[value]) {
                        bound = TranslationManager.getDataFieldState(option, value);
                    }
                    else {
                        bound = TranslationManager.getDataFieldState(terms, 'none');
                    }
                }
            }
            return bound || typeof result !== 'string' ? result : TranslationManager.translate(result);
        };

        const paramProps = ['mhp', 'mmp', 'atk', 'def', 'mat', 'mdf', 'agi', 'luk'];

        TranslationManager._descriptionTemplateTransDepth++;
        try {
            template = TranslationManager.translate(template);
        }
        finally {
            TranslationManager._descriptionTemplateTransDepth--;
        }

        if (Utils.RPGMAKER_NAME === 'MV') {
            template = template.replace(/\\n/g, '\n');
        }

        return template.replace(/\$\{(.*?)}/g, function (_, propName) {
            if (propName === 'description') {
                return textValue(data, 'prevDesc', false);
            }
            else if (data.meta && data.meta.hasOwnProperty(propName)) {
                return textValue(data.meta, propName, true);
            }
            else if (data.damage && data.damage.hasOwnProperty(propName)) {
                return textValue(data.damage, propName, true);
            }
            else if (data.hasOwnProperty(propName)) {
                return textValue(data, propName, true);
            }
            const paramIndex = paramProps.indexOf(propName);
            return paramIndex >= 0 ? textValue(data.params, paramIndex, false) : '';
        });
    }

    //DescriptionTemplate.js
    //1.0.0
    //MV/MZ
    //hard coded
    function patch_DescriptionTemplate() {
        [$dataItems, $dataSkills, $dataWeapons, $dataArmors].forEach(function (array) {
            if (!array) return;
            array.forEach(function (data) {
                const state = data && TranslationManager._descriptionTemplateStates.get(data);
                if (!state) return;
                const descriptor = Object.getOwnPropertyDescriptor(data, 'description');
                if (!descriptor || descriptor.get !== state.nativeGetter) return;
                //DT has description configurable left empty, but its an existing object
                TranslationManager.bindDerivedDataField(data,
                    'description',
                    function () {
                        return TranslationManager.disablePluginTrans(function () {
                            return state.nativeGetter.call(data);
                        });
                    },
                    function () {
                        return createTranslatedDescription(data, state.template);
                    }
                );
            });
        });
    }

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
                    //if (item.description) tField(item, "description");
                    const description = Object.getOwnPropertyDescriptor(item, 'description');
                    if (
                        description &&
                        Object.prototype.hasOwnProperty.call(description, 'value') &&
                        typeof description.value === 'string'
                    )
                        tField(item, 'description'); //non DT bond field only
                    //if (item.note) item.note = TranslationManager.translate(item.note, times = 1);
                    //if (item.preName) item.preName = item.name;
                    if (item.preName) {
                        TranslationManager.setDataField(
                            item,
                            'preName',
                            TranslationManager.getRawData(item, 'preName'),
                            item.name);
                    }
                    //if (item.preDescription) item.preDescription = item.description; // for ItemNameEscape.js
                    if (item.preDescription && !TranslationManager._descriptionTemplateStates.has(item)) {
                        TranslationManager.setDataField(
                            item,
                            'preDescription',
                            TranslationManager.getRawData(item, 'preDescription'),
                            item.description);
                    }
                    //ItemNameEscape.js don seem compatible w/ DescriptionTemplate in preDrescription
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
                    TranslationManager.bindDataArray($dataSystem.terms.commands);
                    $dataSystem.terms.commands.forEach(function (_, index) {
                        tField(
                            $dataSystem.terms.commands,
                            index
                        );
                    })
                    /*
                    $dataSystem.terms.commands.forEach((term, i) => {
                        $dataSystem.terms.commands[i] = TranslationManager.translate(term);
                    });
                    */
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

            // Also variable and switch NAMES
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
                TranslationManager.translateDataField($dataSystem, "gameTitle");
                //$dataSystem.gameTitle = TranslationManager.translate($dataSystem.gameTitle);
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
            TranslationManager.fetchRawData(() => {
                return _Game_Actor_setup.call(this, actorId);
            })
            //fishy in vanilla setup sequence
            //ref DynamicBattlerParam

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
            TranslationManager.fetchRawData(() => {
                return _Game_Actor_setup.call(this, actorId);
            })
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
            DynamicDatabaseManager._jtDDStringPropertyPatched
        ) return;

        const manager = DynamicDatabaseManager;
        const _makePropertyString = manager._makePropertyString;
        const _makeProperty = manager._makeProperty;

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

        manager._makePropertyString = function (parent, key, child, sourceChild) {
            /*
            const fields = TranslationManager._dataFieldStates.get(parent);
            const field = fields && fields.get(String(key));
            */
            //now it uses derived field
            const field = TranslationManager.getDataFieldState(parent, key);

            //vanilla DD function for non JtJson dataField object
            if (!field) {
                return _makePropertyString.call(this, parent, key, child);
            }

            //when DT installed?
            //snapshot of child when DD initialize
            if (field.readRaw) {
                const rawChild = arguments.length > 3 ? sourceChild : TranslationManager.getRawData(parent, key);
                const translatedChild = child;
                _makePropertyString.call(this, parent, key, child);
                return TranslationManager.bindDerivedDataField(
                    parent,
                    key,
                    function () {
                        return TranslationManager.disablePluginTrans(function () {
                            return convertEscapeCharacters(rawChild);
                        })
                    },
                    function () {
                        return convertEscapeCharacters(translatedChild);
                    }
                );
            }

            _makePropertyString.call(this, parent, key, child);
            Object.defineProperty(parent, key, { set: undefined });

            return TranslationManager.bindDerivedDataField(
                parent,
                key,
                function () {
                    return TranslationManager.disablePluginTrans(function () {
                        return convertEscapeCharacters(typeof field.raw === 'string' ? field.raw : child);
                    })
                },
                function () {
                    return convertEscapeCharacters(typeof field.translated === 'string' ? field.translated : child);
                },
                field
            );
        };

        if (typeof _makeProperty === 'function') {
            manager._makeProperty = function (parent, keyPath, key, child) {
                const field = TranslationManager.getDataFieldState(parent, key);
                if (field) {
                    const rawChild = TranslationManager.getRawData(parent, key);
                    if (typeof rawChild === 'string' && /\\/.test(rawChild)) {
                        return this._makePropertyString(parent, key, child, rawChild);
                    }
                    if (typeof rawChild === 'string') {
                        return _makeProperty.call(this, parent, keyPath, key, rawChild);
                    }
                }

                return _makeProperty.apply(this, arguments);
            };
        }

        manager._jtDDStringPropertyPatched = true;
    }

    function patch_DynamicDatabase_FormulaFields() {
        if (typeof DynamicDatabaseManager === 'undefined' ||
            typeof DynamicDatabaseManager._makePropertyFormula !== 'function' ||
            DynamicDatabaseManager._jtDDFormulaPatched
        ) return;

        const _makePF = DynamicDatabaseManager._makePropertyFormula;
        DynamicDatabaseManager._makePropertyFormula = function (parent, key) {
            const result = _makePF.apply(this, arguments);

            const descriptor = Object.getOwnPropertyDescriptor(parent, key);
            if (!descriptor ||
                typeof descriptor.get !== 'function' ||
                !descriptor.configurable
            ) return result;

            const _oriGetter = descriptor.get;
            descriptor.get = function () {
                return TranslationManager.fetchRawData(() => {
                    return _oriGetter.call(this);
                })
            }

            Object.defineProperty(parent, key, descriptor);
            return result;
        }

        DynamicDatabaseManager._jtDDFormulaPatched = true;
    }

    //DynamicDatabase.js
    //1.3.5
    //MV
    //maybe also 2.1.4 MZ
    //give up fine detail rawdatadepth control based on usage ig
    function patch_DynamicDatabaseComplex() {
        patch_DynamicDatabase_StringFields();
        patch_DynamicDatabase_FormulaFields();

        if (isDynamicDatabaseActor()) {
            patch_DynamicDatabase_ActorFields();
        }
        else {
            patch_GameActorNameFields();
        }
    }

    //ItemNameEscape.js
    //1.0.2
    //MV
    //1.1.2
    //MZ
    function patch_ItemNameEscape() {
        if (typeof DataManager.convertName !== 'function' ||
            typeof DataManager.databaseEscape !== 'function' ||
            DataManager._jtItemNameEscapePatched
        ) return;
        const _convertName = DataManager.convertName;
        DataManager.convertName = function (data) {
            const name = TranslationManager.getDataFieldState(data, 'name');
            const description = TranslationManager.getDataFieldState(data, 'description');
            //not in raw value context n name/description is bonded by JtJson
            if (!TranslationManager.isRawData() && (name || description)) {
                //update raw field
                const manager = this;
                TranslationManager.fetchRawData(function () {
                    return TranslationManager.disablePluginTrans(function () {
                        return _convertName.call(manager, data);
                    });
                });
            }
            //update translated field
            return _convertName.apply(this, arguments);
        };
        DataManager._jtItemNameEscapePatched = true;
    }

    //SceneGlossary.js 
    //2.23.2 
    //MV
    //Regarding param.AutoAddition, too complicated to patch startMessage n gainGlossaryFromText back to vanilla logic.
    //ASSUME glossary table is used during translation so that its still there after trans.
    //Also skipping getGlossaryCompleteMessage since 収集率 is usually recognized by mtool.
    function patch_SceneGlossary() {
        if (typeof Window_Glossary === 'undefined') return;
        if (Window_Glossary.prototype._jtPatched) return;
        Window_Glossary.prototype._jtPatched = true;

        const _getPictureName = Window_Glossary.prototype.getPictureName;
        if (typeof _getPictureName === "function") {
            Window_Glossary.prototype.getPictureName = function (index) {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _getPictureName.call(this, index);
                    })
                })
            }
        }

        const _getPlusPictureData = Window_Glossary.prototype.getPlusPictureData;
        if (typeof _getPlusPictureData === "function") {
            Window_Glossary.prototype.getPlusPictureData = function (imageIndex, index) {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _getPlusPictureData.call(this, imageIndex, index);
                    })
                })
            }
        }

        const _getED = Window_Glossary.prototype.getEnemyData;
        if (typeof _getED === 'function') {
            Window_Glossary.prototype.getEnemyData = function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _getED.apply(this, arguments);
                    })
                })
            }
        }

        const _addEG = Game_Troop.prototype.addEnemyGlossary;
        if (typeof _addEG === 'function') {
            Game_Troop.prototype.addEnemyGlossary = function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _addEG.apply(this, arguments);
                    })
                })
            }
        }

        //postpone trans to drawItemText 
        //text to be displayed shouldnt change much through all those keyword proc
        const _getDes = Window_Glossary.prototype.getDescription;
        if (typeof _getDes === 'function') {
            Window_Glossary.prototype.getDescription = function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _getDes.apply(this, arguments);
                    })
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
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommandPictureAnimation.call(this, command, args)
                })
            })
        }

        Game_Interpreter._jtPictureAnimationPatched = true;
    }

    //PictureAnimation.js
    //1.1.3
    //MZ
    //abondoned
    function patch_PictureAnimation_MZ() {
        if (Utils.RPGMAKER_NAME !== "MZ") return;
        const proto = Game_Picture.prototype;
        if (typeof proto.setAnimationFrameInit !== 'function' ||
            proto._jtPictureAnimationMZPatched
        ) return;

        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        const commands = PluginManager._commands;
        for (const command of [
            "INIT",
            "START",
            "STOP",
            "SET_CELL",
            "LINK_VARIABLE",
            "LINK_SOUND"
        ]) {
            commands['PictureAnimation:' + command] = wrapRaw(commands['PictureAnimation:' + command]);
        };
        proto.isEndFirstLoop = wrapRaw(proto.isEndFirstLoop);
        proto.playCellSe = wrapRaw(proto.playCellSe);
        proto._jtPictureAnimationMZPatched = true;
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
            'SV_ボイスの演奏', 'SV_PLAY_VOICE',
            'SV_ボイスのループ演奏', 'SV_PLAY_LOOP_VOICE',
            'SV_ボイスの停止', 'SV_STOP_VOICE',
            'SV_ボイスの演奏の予約', 'SV_RESERVE_VOICE',
            'SV_ボイスのループ演奏の予約', 'SV_RESERVE_LOOP_VOICE'
        ].map(command => command.toUpperCase()));

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (simpleVoiceCommands.has(String(command).toUpperCase())) {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        _pluginCommand.call(this, command, args);
                    })
                })
            }
            _pluginCommand.call(this, command, args);
        }

        Game_Interpreter._jtSimpleVoicePatched = true;
    }

    //SimpleVoice.js
    //2.0.5
    //MZ
    //using \N[n] in filename is reasonable, maybe =.=
    function patch_SimpleVoice_MZ() {
        if (Utils.RPGMAKER_NAME !== "MZ" ||
            PluginManager._jtSimpleVoiceMZPatched
        ) return;

        const commands = PluginManager._commands;
        const keys = [
            "SimpleVoice:PLAY_VOICE",
            "SimpleVoice:STOP_VOICE"
        ];
        if (!commands ||
            !keys.every(key => typeof commands[key] === 'function')
        ) return;

        for (const key of keys) {
            const ori = commands[key];
            commands[key] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            }
        }

        const _playV = AudioManager.playVoice;
        const _stopV = AudioManager.stopVoice;
        AudioManager.playVoice = function () {
            return TranslationManager.fetchRawData(() => {
                return _playV.apply(this, arguments);
            })
        }
        AudioManager.stopVoice = function () {
            return TranslationManager.fetchRawData(() => {
                return _stopV.apply(this, arguments);
            })
        }

        PluginManager._jtSimpleVoiceMZPatched = true;
    }

    //PictureVariableSetting.js
    //1.5.3
    //MV
    function patch_PictureVariableSetting() {
        if (typeof Game_Interpreter.prototype.transPictureNumber !== 'function') return;
        if (Game_Interpreter._jtPictureVariableSettingPatched) return;

        const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

        const PictureVariableSettingCommands = new Set([
            'P_VARIABLE_VALID', 'P_VARIABLE_INVALID',
            'P_D_FILENAME',
            'P_TARGET_ALL', 'P_TARGET_RANGE', 'P_TARGET_MULTI',
            'P_SPIN', 'P_SPIN_RELATIVE',
            'P_SHAKE', 'P_STOP_SHAKE',
            'P_OUT_OF_SCREEN_SHAKE_ON', 'P_OUT_OF_SCREEN_SHAKE_OFF'
        ])

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (PictureVariableSettingCommands.has(String(command).toUpperCase())) {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        _pluginCommand.call(this, command, args)
                    })
                })
            }
            _pluginCommand.call(this, command, args)
        }

        Game_Interpreter._jtPictureVariableSettingPatched = true;
    }

    //SystemSoundCustomize.js
    //1.0.0
    //MV
    //MZ hitting /name$/gi in PluginCommonBase so should be safe?
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
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        _pluginCommand.call(this, command, args);
                    })
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
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _battler.call(this, item, user);
                })
            })
        };
        Game_Actor.prototype.canSelectTarget = function (item, user) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _actor.call(this, item, user);
                })
            })
        };
        Game_Enemy.prototype.canSelectTarget = function (item, user) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _enemy.call(this, item, user);
                })
            })
        };

        Game_BattlerBase._jtRestrictionTargetSkillPatched = true;
    }

    //SelfSwitchTemporary.js
    //2.0.1
    //MV
    //No trans needed anyway, but not necessary in average sequence as well
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

    //DTextPicture.js
    //2.10.2
    //MZ
    function patch_DTextPicture_MZ() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            Game_Picture._jtDTextPictureMZPatched
        ) return;

        const commands = PluginManager._commands;
        const keys = [
            "DTextPicture:dText",
            "DTextPicture:dTextSetting",
            "DTextPicture:dTextSettingClear",
            "DTextPicture:windowCursor"
        ];
        if (!commands ||
            !keys.every(key => typeof commands[key] === 'function')
        ) return;

        for (const key of keys) {
            const ori = commands[key];
            commands[key] = function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return ori.apply(this, arguments);
                    })
                })
            }
        };

        //could still be risky?
        const _updateDT = Game_Picture.prototype.updateDText;
        Game_Picture.prototype.updateDText = function () {
            return TranslationManager.enableValueTrans(() => {
                return _updateDT.apply(this, arguments);
            })
        };
        Game_Picture._jtDTextPictureMZPatched = true;
    }

    //Chronus.js
    //1.18.0
    //MV
    //MZ i don think ppl d use logic like $dataActors[1]['n'+'a'+'me'] === 'Alice' ? HH24 * 60 + MI : 0
    function patch_Chronus() {
        if (typeof Game_Interpreter.prototype.pluginCommandChronus !== 'function') return;
        if (Game_Interpreter._jtChronusPatched) return;

        const _pluginCommandChronus = Game_Interpreter.prototype.pluginCommandChronus;
        Game_Interpreter.prototype.pluginCommandChronus = function (command, args) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommandChronus.call(this, command, args);
                })
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
                return _isFoundPlayer.apply(this, arguments);
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

    //MakeScreenCapture.js
    //2.0.0
    //MZ
    function patch_MakeScreenCapture_MZ() {
        if (Utils.RPGMAKER_NAME !== 'MZ') return;
        const proto = Bitmap.prototype;
        if (proto._jtMakeScreenCaptureMZPatched ||
            typeof proto.signImage !== 'function' ||
            typeof proto.drawSignBitmap !== 'function' ||
            typeof proto.signText !== 'function' ||
            typeof PluginManagerEx === 'undefined'
        ) return;

        const _signI = proto.signImage;
        const _drawSB = proto.drawSignBitmap;
        const _signT = proto.signText;
        proto.signImage = function () {
            return TranslationManager.fetchRawData(() => {
                return _signI.apply(this, arguments);
            })
        };
        proto.drawSignBitmap = function () {
            return TranslationManager.fetchRawData(() => {
                return _drawSB.apply(this, arguments);
            })
        };
        const readSignatureText = function (signature) {
            return TranslationManager.fetchRawData(() => {
                const storage = signature && signature._parameter;
                const hasSource = storage && Object.prototype.hasOwnProperty.call(storage, 'signature');
                if (!hasSource) {
                    return TranslationManager.translate(signature.signature);
                };
                const source = storage.signature;
                const template = TranslationManager.translate(source);
                const expanded = TranslationManager.enableValueTrans(() => {
                    return PluginManagerEx.convertVariables(template);
                });
                return template === source ? TranslationManager.translate(expanded) : expanded;
            })
        };
        proto.signText = function (signature) {
            const text = readSignatureText(signature);
            if (!text) return;
            const view = TranslationManager.fetchRawData(() => ({
                signature: text,
                fontFace: signature.fontFace,
                fontSize: signature.fontSize,
                fontColor: signature.fontColor,
                align: signature.align
            }));
            return TranslationManager.skipPluginTrans(() => {
                return _signT.call(this, view);
            });
        }
        proto._jtMakeScreenCaptureMZPatched = true;
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
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommandMessageWindowPopup.call(this, command, args);
                })
            })
        }
        Game_Interpreter.prototype.getEventIdForMessagePopup = function (arg) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _getEventIdForMessagePopup.call(this, arg);
                })
            })
        }

        Game_Interpreter._jtMessageWindowPopupPatched = true;
    }

    //MessageWindowPopup.js
    //1.5.1
    //MZ
    function patch_MessageWindowPopup_MZ() {
        if (Utils.RPGMAKER_NAME !== "MZ" ||
            typeof PluginManagerEx === "undefined" ||
            typeof Game_System.prototype.getTailImage !== "function" ||
            Game_System._jtMessageWindowPopupMZPatched
        ) return;
        const commands = PluginManager._commands;
        const keys = [
            "MessageWindowPopup:POPUP_VALID",
            "MessageWindowPopup:POPUP_INVALID",
            "MessageWindowPopup:FREE_POPUP_VALID",
            "MessageWindowPopup:SUB_WINDOW_SETTING",
            "MessageWindowPopup:POPUP_WINDOW_SETTING",
            "MessageWindowPopup:POPUP_ADJUST_POSITION",
            "MessageWindowPopup:POPUP_ADJUST_SIZE",
            "MessageWindowPopup:CHANGE_TAIL",
            "MessageWindowPopup:BATTLE_POPUP_VALID"
        ];
        if (!commands) return;
        for (const key of keys) {
            const ori = commands[key];
            if (typeof ori !== 'function') continue;
            commands[key] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            };
        };
        const _getTI = Game_System.prototype.getTailImage;
        Game_System.prototype.getTailImage = function () {
            return TranslationManager.fetchRawData(() => {
                return _getTI.apply(this, arguments);
            })
        };
        if (typeof Window_Message.prototype.createVirtualTextState === 'function') {
            const _createVTS = Window_Message.prototype.createVirtualTextState;
            const _CEC = Window_Message.prototype.convertEscapeCharacters;
            let _virtualWindow = null;
            Window_Message.prototype.createVirtualTextState = function () {
                const _prevWindow = _virtualWindow;
                _virtualWindow = this;
                try {
                    return _createVTS.apply(this, arguments);
                } finally {
                    _virtualWindow = _prevWindow;
                }
            };
            //again, maybe remove the detection be4 pushConvertedText?
            Window_Message.prototype.convertEscapeCharacters = function () {
                const converted = _CEC.apply(this, arguments);
                if (_virtualWindow === this && !TranslationManager.isRawData() && TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0) {
                    TranslationManager.pushConvertedText(converted);
                }
                return converted;
            };
        }
        Game_System._jtMessageWindowPopupMZPatched = true;
    }

    //TraceEvent.js
    //1.2.0
    //MV
    //1.3.1
    //MZ
    function patch_TraceEvent() {
        if (typeof Game_Map.prototype.filterEventsByName !== 'function' ||
            typeof Game_Map.prototype.filterEventsByTag !== 'function'
        ) return;
        if (Game_Map._jtTraceEventPatched) return;

        const _filterByName = Game_Map.prototype.filterEventsByName;
        const _filterByTag = Game_Map.prototype.filterEventsByTag;
        Game_Map.prototype.filterEventsByName = function (name, selfEvent) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _filterByName.call(this, name, selfEvent);
                })
            })
        };
        Game_Map.prototype.filterEventsByTag = function (tagName, selfEvent) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _filterByTag.call(this, tagName, selfEvent);
                })
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

        const variableValue = Game_Variables.prototype.value;
        const switchValue = Game_Switches.prototype.value;
        const params = PluginManager.parameters('DynamicVariables');
        const isDynamicVariable = function (variableId) {
            return variableId >= params.DynamicVariableStart &&
                variableId <= params.DynamicVariableEnd;
        }
        const isDynamicSwitch = function (switchId) {
            return switchId >= params.DynamicSwitchStart &&
                switchId <= params.DynamicSwitchEnd;
        }

        Game_Variables.prototype.value = function (variableId) {
            if (!isDynamicVariable(variableId)) {
                return variableValue.apply(this, arguments);
            }

            const translateForDisplay = !TranslationManager.isRawData() && TranslationManager._CECDepth > 0;
            const result = TranslationManager.fetchRawData(() => {
                return variableValue.apply(this, arguments);
            })
            //should mirror variable values trans gating
            return translateForDisplay && typeof result === 'string' ? TranslationManager.translate(result) : result;
        }

        Game_Switches.prototype.value = function (switchId) {
            if (!isDynamicSwitch(switchId))
                return switchValue.apply(this, arguments);

            return TranslationManager.fetchRawData(() => {
                return switchValue.apply(this, arguments);
            })
        }

        Game_Variables._jtDynamicVariablesPatched = true;
    }

    //DynamicActorGraphic.js
    //1.2.3
    //MV
    //filename w\ \N[n] possibility, not complex anyway
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
    //MZ 1.1.0 safe
    function patch_DynamicDatabaseNote() {
        if (Utils.RPGMAKER_NAME !== "MV") return;
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
            "MP_SET_MOVIE", "MP_動画設定",
            "MP_SET_LOOP", "MP_ループ設定",
            "MP_SET_SPEED", "MP_速度設定",
            "MP_SET_PAUSE", "MP_ポーズ設定",
            "MP_SET_WAIT", "MP_ウェイト設定",
            "MP_SET_LIMIT", "MP_リミット設定",
            "MP_SET_VOLUME", "MP_音量設定",
            "MP_SET_VOLUME_TYPE", "MP_音量種別設定",
            "MP_SET_OUTER_MOVIE", "MP_外部動画設定",
        ]);

        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (MPCommands.has(String(command).toUpperCase())) {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        _pluginCommand.call(this, command, args);
                    });
                })
            }
            _pluginCommand.call(this, command, args);
        };

        Game_Interpreter._jtMoviePicturePatched = true;
    }

    //MoviePicture.js
    //2.3.1
    //MZ
    //similar filename by \N[n]
    function patch_MoviePicture_MZ() {
        if (typeof Game_Picture.prototype.showVideo !== 'function' ||
            typeof Game_Enemy.prototype.updateVideoName !== 'function' ||
            typeof ImageManager.getVideoFileExt !== 'function' ||
            Game_Picture._jtMoviePictureMZPatched
        ) return;

        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        }
        Game_Picture.prototype.showVideo = wrapRaw(Game_Picture.prototype.showVideo);
        Game_Enemy.prototype.updateVideoName = wrapRaw(Game_Enemy.prototype.updateVideoName);
        ImageManager.getVideoFileExt = wrapRaw(ImageManager.getVideoFileExt);
        Game_Picture._jtMoviePictureMZPatched = true;
    }

    //FileDownloader.js
    //1.1.0
    //MV
    //havent seen any use case yet
    //1.1.0
    //MZ
    function patch_FileDownloader() {
        if (typeof Game_Interpreter.prototype.pluginCommandFileDownloader !== 'function' ||
            Game_Interpreter._jtFileDownloaderPatched
        ) return;

        const _pluginCommandDownloader = Game_Interpreter.prototype.pluginCommandFileDownloader;
        Game_Interpreter.prototype.pluginCommandFileDownloader = function (command, args) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    _pluginCommandDownloader.call(this, command, args);
                });
            })
        };

        Game_Interpreter._jtFileDownloaderPatched = true;
    }

    //StatusBustImage.js
    //1.9.0
    //MV
    //1.9.4
    //MZ
    function patch_StatusBustImage() {
        if (typeof Window_Base.prototype.refreshBust === 'function' &&
            !Window_Base._jtStatusBustImangePatched
        ) {
            const _refreshBust = Window_Base.prototype.refreshBust;
            Window_Base.prototype.refreshBust = function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _refreshBust.call(this);
                    });
                })
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
    //MZ safe
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
    //MZ ignoring %1 trans mismatch
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

    //PictureCallCommon.js
    //1.6.4
    //MZ
    function patch_PictureCallCommon_MZ() {
        if (Utils.RPGMAKER_NAME !== "MZ" ||
            typeof Game_Screen.prototype.addPictureEvent !== 'function' ||
            typeof PluginManagerEx.createCommandArgs !== 'function' ||
            PluginManagerEx._jtPictureCallCommonMZPatched
        ) return;

        const keys = new Set([
            "PictureCallCommon:ADD_PICTURE_EVENT",
            "PictureCallCommon:REMOVE_PICTURE_EVENT",
            "PictureCallCommon:SET_PICTURE_PREFERENCE"
        ]);

        const _createCA = PluginManagerEx.createCommandArgs;
        PluginManagerEx.createCommandArgs = function (args, commandKey) {
            if (!keys.has(commandKey)) return _createCA.apply(this, arguments);

            const result = TranslationManager.fetchRawData(() => {
                return _createCA.apply(this, arguments);
            });

            if (!result || typeof result !== 'object') return result;

            Object.getOwnPropertyNames(result).forEach(name => {
                const descriptor = Object.getOwnPropertyDescriptor(result, name);
                if (!descriptor ||
                    !descriptor.configurable ||
                    typeof descriptor.get !== 'function') return;
                const getter = descriptor.get;
                descriptor.get = function () {
                    return TranslationManager.fetchRawData(() => {
                        return getter.call(this);
                    })
                };
                Object.defineProperty(result, name, descriptor);
            });
            return result;
        }
        PluginManagerEx._jtPictureCallCommonMZPatched = true;
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
    //rlly worthwhile filtering numbers off trans entrance?
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
    //rlly worthwhile filtering numbers off trans entrance?
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

    //CounterExtend.js
    //3.1.0
    //MZ
    function patch_CounterExtend_MZ() {
        if (Utils.RPGMAKER_NAME !== "MZ" ||
            typeof BattleManager.createCounterAction !== 'function' ||
            BattleManager._jtCounterExtendMZPatched
        ) return;

        const _createCA = BattleManager.createCounterAction;
        BattleManager.createCounterAction = function () {
            return TranslationManager.fetchRawData(() => {
                return _createCA.apply(this, arguments)
            })
        }
        BattleManager._jtCounterExtendMZPatched = true;
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
    //1.1.1
    //MZ
    function patch_SaveFileLoadOnly() {
        if (typeof Window_SavefileList.prototype.isLoadOnly !== 'function' ||
            Window_SavefileList._jtSaveFileLoadOnlyPatched
        ) return;

        const _isLoadOnly = Window_SavefileList.prototype.isLoadOnly;
        Window_SavefileList.prototype.isLoadOnly = function (fileId) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isLoadOnly.apply(this, arguments);
                })
            });
        }

        Window_SavefileList._jtSaveFileLoadOnlyPatched = true;
    }

    // ShakeOnDamage.js
    // 1.2.0
    // MV
    // 1.1.0
    // MZ
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
        const _shakeOD = Game_Battler.prototype.shakeOnDamage;
        Game_Battler.prototype.shakeOnDamage = function () {
            return TranslationManager.fetchRawData(() => {
                return _shakeOD.apply(this, arguments);
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
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    })
                })
            }
        };
        Game_Action.prototype.getScopeExtendInfo = wrap(Game_Action.prototype.getScopeExtendInfo);
        Game_Action.prototype.numTargets = wrap(Game_Action.prototype.numTargets);
        Game_Action._jtScopeExtendPatched = true;
    }

    //DirectlyAttackEffect.js
    //1.5.0
    //MV
    function patch_DirectlyAttackEffect() {
        if (typeof Game_Battler.prototype.setDirectlyAttack !== 'function' ||
            typeof Game_Actor.prototype.requestCustomMotion !== 'function'
        ) return;
        if (Game_Battler._jtDirectlyAttackEffectPatched) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    })
                })
            }
        };
        Game_Actor.prototype.performAction = wrap(Game_Actor.prototype.performAction);
        Game_Battler.prototype.setDirectlyAttack = wrap(Game_Battler.prototype.setDirectlyAttack);
        Game_Actor.prototype.requestCustomMotion = wrap(Game_Actor.prototype.requestCustomMotion);
        Game_Battler._jtDirectlyAttackEffectPatched = true;
    }

    //CharacterGraphicExtend.js
    //1.15.0
    //MV
    function patch_CharacterGraphicExtend() {
        if (typeof Game_Event.prototype.getMetaCg !== 'function') return;
        if (Game_Event._jtCharacterGraphicExtendPatched) return;

        const _getMCG = Game_Event.prototype.getMetaCg;
        Game_Event.prototype.getMetaCg = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _getMCG.apply(this, arguments);
                })
            })
        };
        Game_Event._jtCharacterGraphicExtendPatched = true;
    }

    //SceneCustomMenu.js
    //1.27.0
    //MV
    //Not quite confident in this
    function patch_SceneCustomMenu() {
        if (typeof Scene_CustomMenu === 'undefined' ||
            typeof Window_CustomMenuCommand === 'undefined' ||
            typeof Window_CustomMenuDataList === 'undefined'
        ) return;

        const rawWrap = function (proto, name) {
            const oriFunc = proto[name];
            if (typeof oriFunc !== 'function' ||
                oriFunc._jtSceneCustomMenuPatched
            ) return;

            const wrapped = function () {
                return TranslationManager.fetchRawData(() => {
                    return oriFunc.apply(this, arguments);
                })
            }
            wrapped._jtSceneCustomMenuGotoPatched = true;
            proto[name] = wrapped;
        }

        rawWrap(Window_CustomMenuCommand.prototype, 'isScriptValid');
        rawWrap(Window_CustomMenuDataList.prototype, 'makeCommandList');
        rawWrap(Window_CustomMenuDataList.prototype, 'isVisible');
        rawWrap(Window_CustomMenuDataList.prototype, 'isEnabledSub');
        rawWrap(Window_CustomMenuDataList.prototype, 'drawItemSub');
        rawWrap(Scene_CustomMenu.prototype, 'fireEvent');

        if (!SceneManager._jtSceneCustomMenuGotoPatched) {
            const _goto = SceneManager.goto;
            SceneManager.goto = function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _goto.apply(this, arguments);
                    })
                })
            }
            SceneManager._jtSceneCustomMenuGotoPatched = true;
        }
    }

    //MapNameExtend.js
    //1.3.0
    //MV
    function patch_MapNameExtend() {
        if (typeof Game_Map.prototype.isSameDisplayName !== 'function' ||
            Game_Map._jtMapNameExtendPatched
        ) return;

        const _isSDN = Game_Map.prototype.isSameDisplayName;
        Game_Map.prototype.isSameDisplayName = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isSDN.apply(this, arguments);
                })
            })
        }
        Game_Map._jtMapNameExtendPatched = true;
    }

    //CharacterGraphicManager.js
    //1.0.0
    //MV
    function patch_CharacterGraphicManager() {
        if (typeof Game_Actor.prototype.updateDynamicCharacterInfo !== 'function' ||
            Game_Actor._jtCharacterGraphicManagerPatched
        ) return;

        const _updateDCI = Game_Actor.prototype.updateDynamicCharacterInfo;
        Game_Actor.prototype.updateDynamicCharacterInfo = function () {
            return TranslationManager.fetchRawData(() => {
                return _updateDCI.apply(this, arguments);
            })
        }
        Game_Actor._jtCharacterGraphicManagerPatched = true;
    }

    //CharacterPictureManager.js
    //1.0.0
    //MV
    function patch_CharacterPictureManager() {
        if (typeof Game_Interpreter.prototype.pluginCommandCharacterPictureManager !== 'function' ||
            Game_Interpreter._jtCharacterPictureManagerPatched
        ) return;
        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        };
        Game_Interpreter.prototype.pluginCommandCharacterPictureManager = wrap(Game_Interpreter.prototype.pluginCommandCharacterPictureManager);
        if (typeof Game_Battler.prototype.getPictureName === 'function') {
            Game_Battler.prototype.getPictureName = wrap(Game_Battler.prototype.getPictureName);
        }
        if (typeof Game_Battler.prototype.getCpX === 'function') {
            Game_Battler.prototype.getCpX = wrap(Game_Battler.prototype.getCpX);
        }
        if (typeof Game_Battler.prototype.getCpY === 'function') {
            Game_Battler.prototype.getCpY = wrap(Game_Battler.prototype.getCpY);
        }
        if (typeof Game_Actor.prototype.getCgName === 'function') {
            Game_Actor.prototype.getCgName = wrap(Game_Actor.prototype.getCgName);
        }
        if (typeof Game_Item.prototype.getMaxEndurance === 'function') {
            Game_Item.prototype.getMaxEndurance = wrap(Game_Item.prototype.getMaxEndurance);
        }
        Game_Interpreter._jtCharacterPictureManagerPatched = true;
    }

    //CharacterPictureManager.js
    //3.20.0
    //MZ
    function patch_CharacterPictureManager_MZ() {
        if (typeof Scene_Base.prototype.updateStandPicture !== 'function' ||
            Scene_Base._jtCharacterPictureManagerMZPatched
        ) return;

        const patchedPrototypes = new WeakSet();
        const _updateSP = Scene_Base.prototype.updateStandPicture;
        Scene_Base.prototype.updateStandPicture = function (...args) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    const result = _updateSP.apply(this, args);
                    const actor = args[0];
                    const sprite = actor && this._standSprites && this._standSprites.get(actor.actorId());
                    const pictureParam = sprite && sprite._pictures;
                    const paramProto = pictureParam && Object.getPrototypeOf(pictureParam);
                    if (paramProto &&
                        !patchedPrototypes.has(paramProto) &&
                        typeof paramProto.updatePictureFiles === 'function') {
                        const _updateFiles = paramProto.updatePictureFiles;
                        paramProto.updatePictureFiles = function () {
                            return TranslationManager.fetchRawData(() => {
                                return TranslationManager.disablePluginTrans(() => {
                                    return _updateFiles.apply(this, arguments);
                                })
                            })
                        }
                        patchedPrototypes.add(paramProto);
                    }
                    return result;
                })
            })
        }

        Scene_Base._jtCharacterPictureManagerMZPatched = true;
    }

    //FlexibleBattleBgm.js
    //1.0.1
    //MV
    //MZ name hits /name$/gi, hence safe
    function patch_FlexibleBattleBgm() {
        if (typeof Game_Interpreter.prototype.pluginCommandFlexibleBattleBgm !== 'function' ||
            Game_Interpreter._jtFlexibleBattleBgmPatched
        ) return;

        const _pluginCFBB = Game_Interpreter.prototype.pluginCommandFlexibleBattleBgm;
        Game_Interpreter.prototype.pluginCommandFlexibleBattleBgm = function () {
            return TranslationManager.fetchRawData(() => {
                return _pluginCFBB.apply(this, arguments);
            })
        }
        Game_Interpreter._jtFlexibleBattleBgmPatched = true;
    }

    //FacePicture.js
    //1.2.1
    //MV
    function patch_FacePicture() {
        if (typeof ImageManager.getPictureFaceInfo !== 'function' ||
            ImageManager._jtFacePicturePatched
        ) return;

        const _getPFI = ImageManager.getPictureFaceInfo;
        ImageManager.getPictureFaceInfo = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _getPFI.apply(this, arguments);
                })
            })
        }
        ImageManager._jtFacePicturePatched = true;
    }

    //TkoolMV_PluginCommandBook.js
    //1.1.3
    //MV
    function patch_TkoolMV_PluginCommandBook() {
        if (typeof Game_Interpreter.prototype.pluginCommandBook_unescape !== 'function' ||
            typeof Game_Interpreter.prototype.executePluginCommand !== 'function' ||
            Game_Interpreter._jtTkoolMV_PluginCommandBookPatched
        ) return;

        const _executePC = Game_Interpreter.prototype.executePluginCommand;
        Game_Interpreter.prototype.executePluginCommand = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _executePC.apply(this, arguments);
                })
            })
        }

        const bookParams = PluginManager.parameters('TkoolMV_PluginCommandBook') || {};

        function isEnabled(value) {
            const text = String(value || '').trim().toLowerCase();
            return text === 'true' || text === '1' || text === 'yes' || text === 'はい'
        }

        const scriptEscapeEnabled = isEnabled(bookParams['スクリプトに制御文字適用']);

        //is it necessary to keep cmd355 n cmd111 trans tho
        //given the usual chain of add->refresh, maybe disable callback is okish?
        if (scriptEscapeEnabled) {
            const _cmd355 = Game_Interpreter.prototype.command355;
            Game_Interpreter.prototype.command355 = function () {
                return TranslationManager.fetchRawData(() => {
                    return _cmd355.apply(this, arguments);
                })
            }

            const _cmd111 = Game_Interpreter.prototype.command111;
            Game_Interpreter.prototype.command111 = function () {
                if (this._params && this._params[0] === 12) {
                    return TranslationManager.fetchRawData(() => {
                        return _cmd111.apply(this, arguments);
                    })
                }
                return _cmd111.apply(this, arguments);
            }

            const _processMC = Game_Character.prototype.processMoveCommand;
            Game_Character.prototype.processMoveCommand = function (command) {
                if (command && command.code === Game_Character.ROUTE_SCRIPT) {
                    return TranslationManager.fetchRawData(() => {
                        return _processMC.call(this, command);
                    })
                }
                return _processMC.call(this, command);
            }
        }

        Game_Interpreter._jtTkoolMV_PluginCommandBookPatched = true;
    }

    //EventReSpawn.js
    //1.12.5
    //MV
    //MZ discarding
    function patch_EventReSpawn() {
        if (Utils.RPGMAKER_NAME !== 'MV') return;
        const interpreter = Game_Interpreter.prototype;
        const map = Game_Map.prototype;

        if (typeof interpreter.getEventIdForEventReSpawn !== 'function' ||
            typeof map.appendSpawnMap !== 'function' ||
            interpreter._jtEventReSpawnPatched
        ) return;

        const ers_commands = new Set([
            'ERS_MAKE', 'ERS_生成',
            'ERS_MAKE_RANDOM', 'ERS_ランダム生成',
            'ERS_MAKE_TEMPLATE', 'ERS_テンプレート生成',
            'ERS_MAKE_TEMPLATE_RANDOM', 'ERS_テンプレートランダム生成',
            'ERS_GET_LAST_SPAWN_EVENT_ID', 'ERS_最終生成イベントID取得',
            'ERS_TRY_COUNT'
        ]);

        const pluginC = interpreter.pluginCommand;
        interpreter.pluginCommand = function (command, args) {
            if (typeof command !== 'string' ||
                !ers_commands.has(command.toUpperCase())
            ) {
                return pluginC.apply(this, arguments);
            }

            return TranslationManager.fetchRawData(() => {
                return pluginC.apply(this, arguments);
            });
        };

        const _appendSM = map.appendSpawnMap;
        map.appendSpawnMap = function () {
            return TranslationManager.fetchRawData(() => {
                return _appendSM.apply(this, arguments);
            });
        }

        interpreter._jtEventReSpawnPatched = true;
    }

    //RetryBattle.js
    //1.4.0
    //MV
    //1.6.1
    //MZ
    //there might be some trans omission but can live w/ ig
    function patch_RetryBattle() {
        if (typeof DataManager.saveGameForRetry !== 'function' ||
            DataManager._jtRetryBattlePatched
        ) return;

        const _saveGFR = DataManager.saveGameForRetry;
        DataManager.saveGameForRetry = function () {
            return TranslationManager.fetchRawData(() => {
                return _saveGFR.apply(this, arguments);
            });
        }

        DataManager._jtRetryBattlePatched = true;
    }

    //NobleMushroom.js
    //1.12.1
    //MV
    //1.11.3
    //MZ
    //INPUT_NAME／名前入力 arg0 should be fine in most cases
    function patch_NobleMushroom() {
        if (typeof Game_Interpreter.prototype.pluginCommandBlueMushroom !== 'function' ||
            typeof Game_Message.prototype.popupNameInputPrompt !== 'function' ||
            typeof DataManager.saveGameAuto !== 'function' ||
            Game_Interpreter._jtNobleMushroomPatched
        ) return;
        const bmCommands = new Set([
            'タイプ変更', 'CHANGE_TYPE',
            'ノベルウィンドウ位置設定', 'SET_RECT_NOVEL_WINDOW',
            'ノベルコマンド位置設定', 'SET_RECT_NOVEL_COMMAND',
            'チャプター設定', 'SET_CHAPTER'
        ])
        const _pluginCBM = Game_Interpreter.prototype.pluginCommandBlueMushroom;
        Game_Interpreter.prototype.pluginCommandBlueMushroom = function (command, args) {
            if (typeof command !== 'string' ||
                !bmCommands.has(command.toUpperCase())) {
                return _pluginCBM.apply(this, arguments);
            }
            return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => _pluginCBM.apply(this, arguments)));
        }
        const _popupNIP = Game_Message.prototype.popupNameInputPrompt;
        Game_Message.prototype.popupNameInputPrompt = function () {
            return TranslationManager.fetchRawData(() => _popupNIP.apply(this, arguments));
        }
        const _saveGA = DataManager.saveGameAuto;
        DataManager.saveGameAuto = function () {
            return TranslationManager.fetchRawData(() => _saveGA.apply(this, arguments));
        }
        function _skipTrans(prototype, method) {
            const ori = prototype[method];
            if (typeof ori !== 'function') return;
            prototype[method] = function () {
                return TranslationManager.skipPluginTrans(() => ori.apply(this, arguments));
            };
        };
        function _patchSelectedNovelWindow() {
            if (typeof Window_Message.prototype.isNovelWindow !== 'function' ||
                !Window_Message.prototype.isNovelWindow()
            ) return;
            if (!Window_Message._jtNobleMushroomNovelPatched) {
                _skipTrans(Window_Message.prototype, 'processNormalCharacter');
                _skipTrans(Window_Message.prototype, 'processAutoWordWrap');
                Window_Message._jtNobleMushroomNovelPatched = true;
            }
            if (typeof Window_ChoiceList.prototype.getAllTextHeight !== 'function' || Window_ChoiceList._jtNobleMushroomNovelPatched) return;
            const _commandName = Window_ChoiceList.prototype.commandName;
            Window_ChoiceList.prototype.commandName = function (index) {
                const text = _commandName.apply(this, arguments);
                if (TranslationManager.isRawData() || TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) return text;
                const source = Window_Command.prototype.commandName.call(this, index);
                if (typeof text !== 'string' || typeof source !== 'string') return text;
                const _prefixLength = text.length - source.length;
                if (_prefixLength < 0 || text.slice(_prefixLength) !== source) return text;
                const result = text.slice(0, _prefixLength) + TranslationManager.translate(source);
                TranslationManager._translatedSet.add(result);
                return result;
            };
            _skipTrans(Window_ChoiceList.prototype, 'processAutoWordWrap');
            Window_ChoiceList._jtNobleMushroomNovelPatched = true;
        };
        [
            Scene_Map.prototype,
            Scene_MenuBase.prototype
        ].forEach(prototype => {
            const _changeIWM = prototype.changeImplementationWindowMessage;
            if (typeof _changeIWM !== 'function') return;
            prototype.changeImplementationWindowMessage = function () {
                const result = _changeIWM.apply(this, arguments);
                _patchSelectedNovelWindow();
                return result;
            }
        });
        Game_Interpreter._jtNobleMushroomPatched = true;
    }

    //GameStartEval.js
    //1.0.0
    //MV
    //wats this plugin for tho
    //1.0.0
    //MZ
    //variants actually identical
    function patch_GameStartEval() {
        /*
        const enabled = $plugins.some(function (plugin) {
            return plugin.status && Utils.extractFileName(plugin.name) === 'GameStartEval';
        });
        */
        //Utils.extractFileName() not compatible w/ MV
        const enabled = $plugins.some(function (plugin) {
            return plugin.status &&
                String(plugin.name).split('/').pop() === 'GameStartEval';
        })
        if (!enabled || Scene_Boot._jtGameStartEvalPatched) return;

        const _start = Scene_Boot.prototype.start;
        Scene_Boot.prototype.start = function () {
            return TranslationManager.fetchRawData(() => {
                return _start.apply(this, arguments);
            })
        }

        Scene_Boot._jtGameStartEvalPatched = true;
    }

    //CustomizeConfigItem.js
    //2.4.0
    //MV
    //cant do much abt it
    function patch_CustomizeConfigItem() {
        if (typeof Window_Options.prototype.execScript !== 'function' ||
            Window_Options._jtCustomizeConfigItemPatched
        ) return;

        const _execS = Window_Options.prototype.execScript;
        Window_Options.prototype.execScript = function () {
            return TranslationManager.fetchRawData(() => {
                return _execS.apply(this, arguments);
            })
        }

        Window_Options._jtCustomizeConfigItemPatched = true;
    }

    //MenuSubCommand.js
    //2.8.0
    //MV
    //I hate all these vague scripts :/
    function patch_MenuSubCommand() {
        if (Utils.RPGMAKER_NAME !== "MV") return;
        if (typeof Window_MenuCommand.prototype.makeSubCommandList !== 'function' ||
            typeof Scene_Menu.prototype.executeSubScript !== 'function' ||
            typeof Game_Temp.prototype.createMenuCommand !== 'function' ||
            Window_MenuCommand._jtMenuSubCommandPatched
        ) return;

        const _makeSMCL = Window_MenuCommand.prototype.makeSubCommandList;
        Window_MenuCommand.prototype.makeSubCommandList = function () {
            return TranslationManager.disablePluginTrans(() => {
                return _makeSMCL.apply(this, arguments);
            })
        }

        const _executeSS = Scene_Menu.prototype.executeSubScript;
        Scene_Menu.prototype.executeSubScript = function () {
            return TranslationManager.fetchRawData(() => {
                return _executeSS.apply(this, arguments);
            })
        }

        const _createMC = Game_Temp.prototype.createMenuCommand;
        const patchedPrototypes = new WeakSet();
        Game_Temp.prototype.createMenuCommand = function (commands) {
            const result = _createMC.apply(this, arguments);

            const parentName = commands.ParentName + commands.CommandId;
            const parents = this._menuParentCommands;
            if (!parents || typeof parents.get !== 'function') {
                return result;
            }

            const subCommands = parents.get(parentName);
            if (!Array.isArray(subCommands) || subCommands.length === 0) {
                return result;
            }

            const instance = subCommands[subCommands.length - 1];
            if (!instance || typeof instance !== 'object') {
                return result;
            }

            const subCommandProto = Object.getPrototypeOf(instance);
            if (!subCommandProto ||
                patchedPrototypes.has(subCommandProto) ||
                !Object.prototype.hasOwnProperty.call(subCommandProto, 'convert') ||
                typeof subCommandProto.convert !== 'function'
            ) {
                return result;
            }

            const _convert = subCommandProto.convert;
            subCommandProto.convert = function () {
                return TranslationManager.fetchRawData(() => {
                    return _convert.apply(this, arguments);
                })
            }

            patchedPrototypes.add(subCommandProto);
            return result;
        }

        Window_MenuCommand._jtMenuSubCommandPatched = true;
    }

    //MenuSubCommand.js
    //4.1.1
    //MZ
    function patch_MenuSubCommand_MZ() {
        if (typeof PluginManagerEx === 'undefined' ||
            typeof Game_Temp.prototype.createMenuCommand !== 'function' ||
            typeof Scene_Menu.prototype.createSubMenuCommandWindow !== 'function' ||
            typeof Window_MenuCommand.prototype.makeSubCommandList !== 'function' ||
            Window_MenuCommand._jtMenuSubCommandPatched
        ) return;
        const wrapped = new WeakMap();
        function wrapLocal(target, name) {
            if (!target || typeof target[name] !== 'function') return;
            let names = wrapped.get(target);
            if (!names) {
                names = new Set();
                wrapped.set(target, names);
            };
            if (names.has(name)) return;

            const ori = target[name];
            target[name] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            };
            names.add(name);
        };

        wrapLocal(Game_Temp.prototype, 'createMenuCommands');
        //indeed there r two of them :o
        const _createC = Game_Temp.prototype.createMenuCommand;
        Game_Temp.prototype.createMenuCommand = function (commands) {
            return TranslationManager.fetchRawData(() => {
                const result = _createC.apply(this, arguments);
                const key = commands.ParentName + commands.CommandId;
                const items = this._menuParentCommands && this._menuParentCommands.get(key);
                const instance = items && items[items.length - 1];
                if (instance) {
                    const proto = Object.getPrototypeOf(instance);
                    [
                        "isReturnMap",
                        "isVisible",
                        "isEnable",
                        "isNeedSelectMember",
                        "getSelectionScript",
                        "getMoveTargetMap"
                    ].forEach(name => wrapLocal(proto, name));
                };
                return result;
            })
        };

        const _makeL = Window_MenuCommand.prototype.makeSubCommandList;
        Window_MenuCommand.prototype.makeSubCommandList = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _makeL.apply(this, arguments);
                })
            })
        };

        [
            "needsCommand",
            "calculateSubCommandX",
            "calculateSubCommandY"
        ].forEach(name => wrapLocal(Window_MenuCommand.prototype, name));

        [
            "loadSubCommandWindowSkin",
            "commandParent",
            "removeSubMenuCommandWindow",
            "onSubCommandOk",
            "executeSubCommand",
            "executeSubScript"
        ].forEach(name => wrapLocal(Scene_Menu.prototype, name));

        [
            "reserveTransferToSubCommandMap",
            "reserveTransferToOriginalMap"
        ].forEach(name => wrapLocal(Game_Player.prototype, name));

        const _createSMCW = Scene_Menu.prototype.createSubMenuCommandWindow;
        Scene_Menu.prototype.createSubMenuCommandWindow = function () {
            return TranslationManager.fetchRawData(() => {
                const result = _createSMCW.apply(this, arguments);
                const instance = this._subMenuWindow;
                if (instance) {
                    const proto = Object.getPrototypeOf(instance);
                    [
                        "loadWindowskin",
                        "itemTextAlign",
                        "windowWidth",
                        "numVisibleRows",
                        "maxCols"
                    ].forEach(name => wrapLocal(proto, name));
                };
                return result;
            })
        };
        Window_MenuCommand._jtMenuSubCommandPatched = true;
    }

    //DynamicBattlerParam.js
    //2.0.2
    //MV
    //not heavy so leave as is?
    function patch_DynamicBattlerParam() {
        const proto = Game_BattlerBase.prototype;
        if (typeof proto.getDynamicParam !== 'function' ||
            typeof proto.getParamFormula !== 'function' ||
            typeof proto.special !== 'function' ||
            Game_BattlerBase._jtDynamicBattlerParamPatched
        ) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        };
        proto.getDynamicParam = wrap(proto.getDynamicParam);
        proto.getParamFormula = wrap(proto.getParamFormula);
        proto.special = wrap(proto.special);

        Game_BattlerBase._jtDynamicBattlerParamPatched = true;
    }

    //ParamTransfer.js
    //1.4.0
    //MV
    function patch_ParamTransfer() {
        if (Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_BattlerBase.prototype.executeParamFormula !== 'function' ||
            Game_BattlerBase._jtParamTransferPatched
        ) return;

        const _executePF = Game_BattlerBase.prototype.executeParamFormula;
        Game_BattlerBase.prototype.executeParamFormula = function () {
            return TranslationManager.fetchRawData(() => {
                return _executePF.apply(this, arguments);
            })
        }

        Game_BattlerBase._jtParamTransferPatched = true;
    }

    //ParamTransfer.js
    //1.5.0
    //MZ
    function patch_ParamTransfer_MZ() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_BattlerBase.prototype.getTransParam !== 'function' ||
            Game_BattlerBase._jtParamTransferMZPatched
        ) return;

        const _getTP = Game_BattlerBase.prototype.getTransParam;
        Game_BattlerBase.prototype.getTransParam = function () {
            return TranslationManager.fetchRawData(() => {
                return _getTP.apply(this, arguments);
            })
        }
        Game_BattlerBase._jtParamTransferMZPatched = true;
    }

    //TraitConditions.js
    //1.2.2
    //MV
    function patch_TraitConditions() {
        if (typeof Game_BattlerBase.prototype.isValidTrait !== 'function' ||
            typeof Game_BattlerBase.prototype.allTraits !== 'function' ||
            Game_BattlerBase._jtTraitConditionsPatched
        ) return;

        const _isVT = Game_BattlerBase.prototype.allTraits;
        Game_BattlerBase.prototype.allTraits = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isVT.apply(this, arguments);
                })
            })
        }

        Game_BattlerBase._jtTraitConditionsPatched = true;
    }

    //NpcFollower.js
    //1.2.0
    //MV
    function patch_NpcFollower() {
        if (typeof Game_Interpreter.prototype.pluginCommandNpcFollower !== 'function' ||
            Game_Interpreter._jtNpcFollowerPatched
        ) return;

        const _pluginCNF = Game_Interpreter.prototype.pluginCommandNpcFollower;
        Game_Interpreter.prototype.pluginCommandNpcFollower = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _pluginCNF.apply(this, arguments);
                })
            })
        }

        Game_Interpreter._jtNpcFollowerPatched = true;
    }

    //CharacterPopupDamage.js
    //1.6.1
    //MV
    function patch_CharacterPopupDamage() {
        if (typeof Game_Interpreter.prototype.pluginCommandCharacterPopupDamage !== 'function' ||
            Game_Interpreter._jtCharacterPopupDamagePatched
        ) return;

        const _pluginCCPD = Game_Interpreter.prototype.pluginCommandCharacterPopupDamage;
        Game_Interpreter.prototype.pluginCommandCharacterPopupDamage = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _pluginCCPD.apply(this, arguments);
                })
            })
        }

        Game_Interpreter._jtCharacterPopupDamagePatched = true;
    }

    //MovieManager.js
    //1.0.5
    //MV
    function patch_MovieManager() {
        if (typeof Game_Interpreter.prototype.pluginCommandMovieManager !== 'function' ||
            Game_Interpreter._jtMovieManagerPatched
        ) return;

        const _pluginCMM = Game_Interpreter.prototype.pluginCommandMovieManager;
        Game_Interpreter.prototype.pluginCommandMovieManager = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _pluginCMM.apply(this, arguments);
                })
            })
        }

        Game_Interpreter._jtMovieManagerPatched = true;
    }

    //BattlerGraphicExtend.js
    //1.4.3
    //MV
    function patch_BattlerGraphicExtend() {
        if (typeof Game_BattlerBase.prototype.refreshGraphicInfo !== 'function' ||
            typeof Game_BattlerBase.prototype.getStateMetaValuesForBge !== 'function' ||
            Game_BattlerBase._jtBattlerGraphicExtendPatched
        ) return;

        const _refreshGI = Game_BattlerBase.prototype.refreshGraphicInfo;
        Game_BattlerBase.prototype.refreshGraphicInfo = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _refreshGI.apply(this, arguments);
                })
            })
        }

        Game_BattlerBase._jtBattlerGraphicExtendPatched = true;
    }

    //MessageNameCommon.js
    //1.3.1
    //MZ
    function patch_MessageNameCommon() {
        if (typeof Window_Message.prototype.callSpeakerCommon !== 'function' ||
            Window_Message._jtMessageNameCommonPatched
        ) return;

        const _callSC = Window_Message.prototype.callSpeakerCommon;
        Window_Message.prototype.callSpeakerCommon = function () {
            return TranslationManager.fetchRawData(() => {
                return _callSC.apply(this, arguments);
            })
        }
        Window_Message._jtMessageNameCommonPatched = true;
    }

    //PictureNameVariable.js
    //1.1.1
    //MZ
    function patch_PictureNameVariable() {
        if (Utils.RPGMAKER_NAME !== "MZ") return;

        const commands = PluginManager._commands;
        const key = "PictureNameVariable:SET_PICTURE_NAME";
        if (!commands ||
            typeof commands[key] !== 'function' ||
            typeof Game_Picture.prototype.updateName !== 'function' ||
            Game_Picture._jtPictureNameVariablePatched
        ) return;

        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        };
        commands[key] = wrap(commands[key]);
        Game_Picture.prototype.updateName = wrap(Game_Picture.prototype.updateName);
        Game_Picture._jtPictureNameVariablePatched = true;
    }

    //PictureGrouping.js
    //1.1.0
    //MZ
    function patch_PictureGrouping() {
        if (typeof Game_Screen.prototype.addGroupingPicture !== 'function' ||
            Game_Screen._jtPictureGroupingPatched
        ) return;

        const _addGP = Game_Screen.prototype.addGroupingPicture;
        Game_Screen.prototype.addGroupingPicture = function () {
            return TranslationManager.fetchRawData(() => {
                return _addGP.apply(this, arguments);
            })
        }
        Game_Screen._jtPictureGroupingPatched = true;
    }

    //NameInputNg.js
    //1.0.0
    //MZ
    //is it rlly necessary tho
    //if its customized then it shouldnt be used in formulas ig?
    function patch_NameInputNg() {
        if (typeof Window_NameEdit.prototype.isNgName !== 'function' ||
            Window_NameEdit._jtNameInputNgPatched
        ) return;

        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        }
        Window_NameEdit.prototype.isNgName = wrapRaw(Window_NameEdit.prototype.isNgName);
        //Window_NameEdit.prototype.setup = wrapRaw(Window_NameEdit.prototype.setup);
        Window_NameEdit._jtNameInputNgPatched = true;
    }

    //AccumulateState.js
    //2.4.1
    //MV
    function patch_AccumulateState() {
        if (Utils.RPGMAKER_NAME !== 'MV' ||
            Game_Interpreter._jtAccumulateStatePatched
        ) return
        const entries = [
            [Game_Interpreter.prototype, 'pluginCommandAccumulateState'],
            [Game_BattlerBase.prototype, 'getGaugeInfo'],
            [Game_Action.prototype, 'applyResistanceForAccumulateState']
        ]

        if (entries.some(([proto, key]) =>
            typeof proto[key] !== 'function'
        )) return;

        entries.forEach(([proto, key]) => {
            const ori = proto[key];
            proto[key] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments)
                })
            }
        })
        Game_Interpreter._jtAccumulateStatePatched = true;
    }

    //AccumulateState.js
    //2.8.0final
    //MZ
    function patch_AccumulateState_MZ() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            Game_Action._jtAccumulateStateMZPatched
        ) return;
        if (typeof Game_Action.prototype.applyResistanceForAccumulateState !== 'function') return;
        const wrap = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    });
                });
            };
        };
        Game_Action.prototype.applyResistanceForAccumulateState = wrap(Game_Action.prototype.applyResistanceForAccumulateState);
        Scene_Base.prototype.createAccumulateState = wrap(Scene_Base.prototype.createAccumulateState);
        Scene_Battle.prototype.createAccumulateState = wrap(Scene_Battle.prototype.createAccumulateState);
        Game_Action._jtAccumulateStateMZPatched = true;
    }

    //ActionEffectExtend.js
    //1.0.0
    //MZ
    function patch_ActionEffectExtend() {
        if (typeof Game_Action.prototype.findItemEffectExtend !== 'function' ||
            typeof Game_Battler.prototype.applyEffectExtendItem !== 'function' ||
            Game_Action._jtActionEffectExtendPatched
        ) return;

        const _findIEE = Game_Action.prototype.findItemEffectExtend;
        const _applyEEI = Game_Battler.prototype.applyEffectExtendItem;
        Game_Action.prototype.findItemEffectExtend = function () {
            return TranslationManager.fetchRawData(() => {
                return _findIEE.apply(this, arguments);
            })
        }
        Game_Battler.prototype.applyEffectExtendItem = function () {
            return TranslationManager.fetchRawData(() => {
                return _applyEEI.apply(this, arguments);
            })
        }
        Game_Action._jtActionEffectExtendPatched = true;
    }

    //AutoActionExclude.js
    //1.1.0
    //MZ
    function patch_AutoActionExclude() {
        if (typeof Game_Action.prototype.isAutoExclude !== 'function' ||
            Game_Action._jtAutoActionExcludePatched
        ) return;

        const _isAE = Game_Action.prototype.isAutoExclude;
        Game_Action.prototype.isAutoExclude = function () {
            return TranslationManager.fetchRawData(() => {
                return _isAE.apply(this, arguments);
            })
        }
        Game_Action._jtAutoActionExcludePatched = true;
    }

    //BattleLogReplace.js
    //1.0.0
    //MZ
    //give up on reviving raw text to replace so basically useless, whatever
    function patch_BattleLogReplace() {
        if (typeof Window_BattleLog.prototype.isValidRegExp !== 'function' ||
            Window_BattleLog._jtBattleLogReplacePatched
        ) return;

        const _isVRE = Window_BattleLog.prototype.isValidRegExp;
        Window_BattleLog.prototype.isValidRegExp = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _isVRE.apply(this, arguments);
                })
            })
        }
        Window_BattleLog._jtBattleLogReplacePatched = true;
    }

    //ChargeTimeControl.js
    //1.2.2
    //MZ
    function patch_ChargeTimeControl() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Action.prototype.applyChangeChargeTime !== 'function' ||
            typeof Game_Battler.prototype.findChargeTimeRate !== 'function' ||
            Game_Action._jtChargeTimeControlPatched
        ) return;

        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        }
        PluginManager._commands['ChargeTimeControl:ChangeChargeTime'] = wrapRaw(PluginManager._commands['ChargeTimeControl:ChangeChargeTime']);
        PluginManager._commands['ChargeTimeControl:ChangeEnemyChargeTime'] = wrapRaw(PluginManager._commands['ChargeTimeControl:ChangeEnemyChargeTime']);
        Game_Action.prototype.applyChangeChargeTime = wrapRaw(Game_Action.prototype.applyChangeChargeTime);
        Game_Battler.prototype.findChargeTimeRate = wrapRaw(Game_Battler.prototype.findChargeTimeRate);
        Game_Action._jtChargeTimeControlPatched = true;
    }

    //ConditionalXparam.js
    //1.0.0
    //MZ
    function patch_ConditionalXparam() {
        if (typeof Game_BattlerBase.prototype.isMatchXparamCondition !== 'function' ||
            Game_BattlerBase._jtConditionalXparamPatched
        ) return;

        const _isMXC = Game_BattlerBase.prototype.isMatchXparamCondition;
        Game_BattlerBase.prototype.isMatchXparamCondition = function () {
            return TranslationManager.fetchRawData(() => {
                return _isMXC.apply(this, arguments);
            })
        }
        Game_BattlerBase._jtConditionalXparamPatched = true;
    }

    //DamageSeEffective.js
    //1.1.0
    //MZ
    function patch_DamageSeEffective() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof SoundManager.setDamageSeEffective !== 'function' ||
            SoundManager._jtDamageSeEffectivePatched
        ) return;

        const _setDSE = SoundManager.setDamageSeEffective;
        SoundManager.setDamageSeEffective = function () {
            return TranslationManager.fetchRawData(() => {
                return _setDSE.apply(this, arguments);
            })
        }
        SoundManager._jtDamageSeEffectivePatched = true;
    }

    //EncounterFormula.js
    //1.0.0
    //MZ
    function patch_EncounterFormula() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            Game_Player._jtEncounterFormulaPatched
        ) return;

        const enabled = $plugins.some(function (plugin) {
            return plugin.status && Utils.extractFileName(plugin.name) === 'EncounterFormula';
        });
        if (!enabled) return;

        const _makeEC = Game_Player.prototype.makeEncounterCount;
        Game_Player.prototype.makeEncounterCount = function () {
            return TranslationManager.fetchRawData(() => {
                return _makeEC.apply(this, arguments);
            })
        }
        Game_Player._jtEncounterFormulaPatched = true;
    }

    //EnemyOverlay.js
    //1.1.0
    //MZ
    function patch_EnemyOverlay() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Enemy.prototype.isValidOverlay !== 'function' ||
            typeof Sprite_Enemy.prototype.createOverlaySprites !== 'function' ||
            Game_Enemy._jtEnemyOverlayPatched
        ) return;

        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        }
        Game_Enemy.prototype.isValidOverlay = wrapRaw(Game_Enemy.prototype.isValidOverlay);
        Sprite_Enemy.prototype.createOverlaySprites = wrapRaw(Sprite_Enemy.prototype.createOverlaySprites);
        Game_Enemy._jtEnemyOverlayPatched = true;
    }

    //ExtraGauge.js
    //1.24.2
    //MZ
    //forget those niche layout entries, nobody will use N/P values to decide layout params...
    function patch_ExtraGauge() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Sprite_ExtraGauge === 'undefined' ||
            typeof Sprite_ExtraGauge.prototype.findValue !== 'function' ||
            Sprite_ExtraGauge._jtExtraGaugePatched
        ) return;
        const _findV = Sprite_ExtraGauge.prototype.findValue;
        Sprite_ExtraGauge.prototype.findValue = function () {
            return TranslationManager.fetchRawData(() => {
                return _findV.apply(this, arguments);
            })
        }
        Sprite_ExtraGauge._jtExtraGaugePatched = true;
    }

    //ItemStealAction.js
    //1.0.0
    //MZ
    function patch_ItemStealAction() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Action.prototype.applyItemSteal !== 'function' ||
            Game_Action._jtItemStealActionPatched
        ) return;

        const _applyIS = Game_Action.prototype.applyItemSteal;
        Game_Action.prototype.applyItemSteal = function () {
            return TranslationManager.fetchRawData(() => {
                return _applyIS.apply(this, arguments);
            })
        }
        Game_Action._jtItemStealActionPatched = true;
    }

    //PartyCommandScene.js
    //1.1.1
    //MZ
    function patch_PartyCommandScene() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof SceneManager.pushPartyCommandScene !== 'function' ||
            SceneManager._jtPartyCommandScenePatched
        ) return;
        const _pushPCS = SceneManager.pushPartyCommandScene;
        SceneManager.pushPartyCommandScene = function () {
            return TranslationManager.fetchRawData(() => {
                return _pushPCS.apply(this, arguments);
            })
        }
        SceneManager._jtPartyCommandScenePatched = true;
    }

    // RemoveStateExtend.js
    // 1.3.0
    // MZ
    function patch_RemoveStateExtend() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Battler.prototype.isRemoveStateExtend !== 'function' ||
            Game_Battler._jtRemoveStateExtendPatched
        ) return;
        const _isRSE = Game_Battler.prototype.isRemoveStateExtend;
        Game_Battler.prototype.isRemoveStateExtend = function () {
            return TranslationManager.fetchRawData(() => {
                return _isRSE.apply(this, arguments);
            })
        }
        Game_Battler._jtRemoveStateExtendPatched = true;
    }

    //SkillChange.js
    //1.2.2
    //MZ
    function patch_SkillChange() {
        if (Utils.RPGMAKER_NAME !== "MZ" ||
            typeof Game_Battler.prototype.meetsSkillChangeCondition !== "function" ||
            Game_Battler._jtSkillChangePatched
        ) return;
        const _meetsSCC = Game_Battler.prototype.meetsSkillChangeCondition;
        Game_Battler.prototype.meetsSkillChangeCondition = function () {
            return TranslationManager.fetchRawData(() => {
                return _meetsSCC.apply(this, arguments);
            })
        }
        Game_Battler._jtSkillChangePatched = true;
    }

    //SkillHitCondition.js
    //1.2.1
    //MZ
    function patch_SkillHitCondition() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Action.prototype.isValidHitCondition !== 'function' ||
            Game_Action._jtSkillHitConditionPatched
        ) return;
        const _isVHC = Game_Action.prototype.isValidHitCondition;
        Game_Action.prototype.isValidHitCondition = function () {
            return TranslationManager.fetchRawData(() => {
                return _isVHC.apply(this, arguments);
            })
        }
        Game_Action._jtSkillHitConditionPatched = true;
    }

    //StateEnchanter.js
    //1.2.1
    //MZ
    function patch_StateEnchanter() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof BattleManager.updateEnchanterStates !== 'function' ||
            BattleManager._jtStateEnchanterPatched
        ) return;

        const patchedPrototypes = new WeakSet();
        const _updateES = BattleManager.updateEnchanterStates;
        BattleManager.updateEnchanterStates = function () {
            const states = this._enchanterStates;
            if (Array.isArray(states)) {
                for (const state of states) {
                    if (!state) continue;
                    const proto = Object.getPrototypeOf(state);
                    if (!proto || patchedPrototypes.has(proto)) continue;
                    const descriptor = Object.getOwnPropertyDescriptor(proto, 'isRemovable');
                    if (!descriptor ||
                        typeof descriptor.value !== 'function' ||
                        !descriptor.writable) continue;
                    const _isR = descriptor.value;
                    proto.isRemovable = function () {
                        return TranslationManager.fetchRawData(() =>
                            _isR.apply(this, arguments)
                        );
                    };
                    patchedPrototypes.add(proto);
                }
            }
            return _updateES.apply(this, arguments);
        }
        BattleManager._jtStateEnchanterPatched = true;
    }

    //StateTrigger.js
    //1.1.0
    //MZ
    function patch_StateTrigger() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Battler.prototype.isStateTriggerValid !== 'function' ||
            typeof Game_Battler.prototype.executeStateTriggerEffect !== 'function' ||
            Game_Battler._jtStateTriggerPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        Game_Battler.prototype.isStateTriggerValid = wrapRaw(Game_Battler.prototype.isStateTriggerValid);
        Game_Battler.prototype.executeStateTriggerEffect = wrapRaw(Game_Battler.prototype.executeStateTriggerEffect);
        Game_Battler._jtStateTriggerPatched = true;
    }

    //TitleCall.js
    //1.8.0
    //MZ
    function patch_TitleCall() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Scene_Title.prototype.playTitleCall !== 'function' ||
            Scene_Title._jtTitleCallPatched
        ) return;
        const _playTC = Scene_Title.prototype.playTitleCall;
        Scene_Title.prototype.playTitleCall = function () {
            return TranslationManager.fetchRawData(() => {
                return _playTC.apply(this, arguments);
            })
        }
        Scene_Title._jtTitleCallPatched = true;
    }

    //TemplateEvent.js
    //2.1.7
    //MV
    //1.4.0
    //MZ
    function patch_TemplateEvent() {
        if (typeof Game_Event.prototype.generateTemplateId !== 'function' ||
            typeof Game_Event.prototype.execConditionScriptForSelfVariable !== 'function' ||
            Game_Event._jtTemplateEventPatched
        ) return;

        const wrapRaw = function (original) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return original.apply(this, arguments);
                });
            };
        };

        if (Utils.RPGMAKER_NAME === 'MV') {
            const _pluginCommand = Game_Interpreter.prototype.pluginCommand;

            const templateEventCommands = new Set([
                'TE固有イベント呼び出し', 'TE_CALL_ORIGIN_EVENT',
                'TEマップイベント呼び出し', 'TE_CALL_MAP_EVENT',
                'TEセルフ変数の操作', 'TE_SET_SELF_VARIABLE',
                'TEセルフ変数の一括操作', 'TE_SET_RANGE_SELF_VARIABLE'
            ].map(command => command.toUpperCase()));

            Game_Interpreter.prototype.pluginCommand = function (command, args) {
                if (templateEventCommands.has(String(command).toUpperCase())) {
                    return TranslationManager.fetchRawData(() => {
                        _pluginCommand.call(this, command, args);
                    })
                }
                _pluginCommand.call(this, command, args);
            }
        } else {
            const commands = PluginManager._commands;
            const pluginName = 'TemplateEvent';
            const commandNames = [
                'CALL_ORIGIN_EVENT',
                'CALL_MAP_EVENT',
                'CALL_TEMPLATE_EVENT',
                'SET_SELF_VARIABLE',
                'SET_RANGE_SELF_VARIABLE'
            ];
            const commandKeys = commandNames.map(function (commandName) {
                return pluginName + ':' + commandName;
            });

            if (!commands) return;
            commandKeys.forEach(function (key) {
                commands[key] = wrapRaw(commands[key]);
            });
        }

        Game_Event.prototype.generateTemplateId = wrapRaw(Game_Event.prototype.generateTemplateId);
        Game_Event.prototype.execConditionScriptForSelfVariable = wrapRaw(Game_Event.prototype.execConditionScriptForSelfVariable);
        const _controlSV = Game_Event.prototype.controlSelfVariable;
        Game_Event.prototype.controlSelfVariable = function (index, type, operand, formulaFlg) {
            if (!formulaFlg) {
                return _controlSV.apply(this, arguments);
            }
            return TranslationManager.fetchRawData(() => {
                return _controlSV.apply(this, arguments);
            })
        }

        if (typeof Game_PrefabEvent !== 'undefined' &&
            Object.prototype.hasOwnProperty.call(Game_PrefabEvent.prototype, 'controlSelfVariable')
        ) {
            const _copiedSV = Game_PrefabEvent.prototype.controlSelfVariable;
            if (typeof _copiedSV === 'function') {
                Game_PrefabEvent.prototype.controlSelfVariable = function (index, type, operand, formulaFlg) {
                    if (!formulaFlg) {
                        return _copiedSV.apply(this, arguments);
                    }
                    return TranslationManager.fetchRawData(() => {
                        return _copiedSV.apply(this, arguments);
                    })
                }
            }
        }

        Game_Event._jtTemplateEventPatched = true;
    }

    //DescriptionExtend.js
    //1.3.1
    //MZ
    function patch_DescriptionExtend() {
        if (typeof PluginManagerEx === 'undefined' ||
            typeof PluginManagerEx.findMetaValue !== 'function' ||
            typeof Window_Help.prototype.isValidDescriptionExtend !== 'function' ||
            Window_Help._jtDescriptionExtendPatched
        ) return;
        const _findMV = PluginManagerEx.findMetaValue;
        PluginManagerEx.findMetaValue = function (object, nameList) {
            const isExtendDesc = Array.isArray(nameList) && nameList.length === 2 && nameList[0] === '拡張説明' && nameList[1] === 'ExtendDesc';
            if (!isExtendDesc) {
                return _findMV.apply(this, arguments);
            };
            return TranslationManager.fetchRawData(() => {
                return _findMV.apply(this, arguments);
            })
        }
        Window_Help._jtDescriptionExtendPatched = true;
    }

    //ProfileExtend.js
    //1.1.1
    //MV/MZ
    function patch_ProfileExtend() {
        if (typeof Game_Interpreter.prototype.setExtendProfile !== 'function' ||
            typeof Game_Actor.prototype.getExtendProfile !== 'function' ||
            typeof Game_Actor.prototype.setExtendProfile !== 'function' ||
            Game_Interpreter._jtProfileExtendPatched
        ) return;
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            const name = typeof command === 'string' ? command.toUpperCase() : '';
            if (name !== 'PE_拡張プロフィール設定' && name !== 'PE_SET_EXTEND_PROFILE') {
                return _pluginC.apply(this, arguments);
            };
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _pluginC.apply(this, arguments);
                })
            })
        };
        Game_Interpreter._jtProfileExtendPatched = true;
    }

    //AttackChain.js
    //3.0.3
    //MZ
    function patch_AttackChain() {
        if (typeof Sprite_ChainCount === "undefined") return;
        const proto = Sprite_ChainCount.prototype;
        if (!proto ||
            typeof proto.updateFont !== 'function' ||
            Sprite_ChainCount._jtAttackChainPatched
        ) return;
        const commands = [
            "loadStaticBitmap",
            "getFontFace",
            "getFontSize",
            "isFontItalic",
            "getOutlineWidth",
            "getOutlineColor",
            "getTextColor"
        ];
        for (const name of commands) {
            const ori = proto[name];
            if (typeof ori !== 'function') continue;
            proto[name] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            }
        };
        Sprite_ChainCount._jtAttackChainPatched = true;
    }

    //TitleNewGameOnly.js
    //2.3.2
    //MZ
    //not likely but SANELY possible to use \N[n] in filename ig
    function patch_TitleNewGameOnly() {
        if (typeof Scene_Title.prototype.createGameStartSprite !== 'function' ||
            Scene_Title._jtTitleNewGameOnlyPatched
        ) return;
        const _createGSS = Scene_Title.prototype.createGameStartSprite;
        Scene_Title.prototype.createGameStartSprite = function () {
            return TranslationManager.fetchRawData(() => {
                return _createGSS.apply(this, arguments);
            })
        };
        Scene_Title._jtTitleNewGameOnlyPatched = true;
    }

    //CommonWithParameter.js
    //1.4.1
    //MZ
    //together w/ MessageCommon.js, \CEP[eventNameString, param] is SANELY legit.
    function patch_CommonWithParameter() {
        const proto = Window_Message.prototype;
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof proto.callMessageCommon !== 'function' ||
            typeof DataManager.setupCommonParameter !== 'function' ||
            Window_Message._jtCommonWithParameterPatched
        ) return;
        const _CEC = proto.convertEscapeCharacters;
        function _containCEP(text) {
            if (typeof text !== 'string') return false;
            const re = /(\\+|\x1b)CEP\[/gi;
            let match;
            while ((match = re.exec(text))) {
                if (match[1] === '\x1b' || match[1].length % 2 === 1) {
                    return true;
                }
            };
            return false;
        };
        proto.convertEscapeCharacters = function (text) {
            if (!_containCEP(text)) {
                return _CEC.apply(this, arguments);
            };
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _CEC.apply(this, arguments);
                })
            })
        };
        Window_Message._jtCommonWithParameterPatched = true;
    }

    //MNKR_HzRandomListMZ.js
    //0.0.1
    //MZ
    function patch_MNKR_HzRandomListMZ() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_System.prototype.putHzRandomList !== 'function' ||
            Game_System.MNKR_HzRandomListMZPatched
        ) return;
        const cmds = PluginManager._commands;
        const pluginName = 'MNKR_HzRandomListMZ';
        const cmdNames = [
            'hzrandomCreate',
            'hzrandomNext',
            'hzrandomShuffle'
        ];
        const cmdKeys = cmdNames.map(function (cmdName) {
            return pluginName + ':' + cmdName;
        });
        cmdKeys.forEach(function (key) {
            if (typeof cmds[key] !== 'function') return;
            const ori = cmds[key];
            cmds[key] = function () {
                return TranslationManager.disablePluginTrans(() => {
                    return ori.apply(this, arguments);
                })
            };
        });
        Game_System.MNKR_HzRandomListMZPatched = true;
    }

    //MNKR_RandomTreasure.js
    //1.0.2
    //MZ
    //possible repeat trans
    function patch_MNKR_RandomTreasure() {
        const cmds = PluginManager._commands;
        if (!cmds || PluginManager._jtMNKR_RandomTreasurePatched) return;
        const ori = cmds['MNKR_RandomTreasure:randomTreasure'];
        if (typeof ori !== 'function') return;
        cmds['MNKR_RandomTreasure:randomTreasure'] = function (args) {
            if (!args || String(args.action) !== 'get') {
                return ori.apply(this, arguments);
            }
            return TranslationManager.fetchRawData(() => {
                return ori.apply(this, arguments);
            })
        };
        PluginManager._jtMNKR_RandomTreasurePatched = true;
    }

    //MNKR_RandomActorNameMV.js
    //0.0.2
    //MV
    //random names might not have trans tho
    function patch_MNKR_RandomActorNameMV() {
        const pluginName = 'MNKR_RandomActorNameMV';
        const params = PluginManager.parameters(pluginName);
        if (!Object.prototype.hasOwnProperty.call(params, 'nameLists') ||
            PluginManager._jtMNKR_RandomActorNameMVPatched
        ) return;
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (command !== pluginName) {
                return _pluginC.apply(this, arguments);
            }
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _pluginC.apply(this, arguments);
                })
            });
        }
        PluginManager._jtMNKR_RandomActorNameMVPatched = true;
    }

    //MNKR_MessageAlignCenterMV.js
    //0.1.0
    //MV
    //trans re entry related
    function patch_MNKR_MessageAlignCenterMV() {
        if (
            !$plugins.some(plugin => plugin.status && plugin.name === 'MNKR_MessageAlignCenterMV') ||
            typeof Window_Base.createDummyWindow !== 'function' ||
            Window_Base._jtMNKR_MessageAlignCenterMVPatched
        ) return;
        const patchedPrototypes = new WeakSet();
        const _createDW = Window_Base.createDummyWindow;
        Window_Base.createDummyWindow = function () {
            const dummy = _createDW.apply(this, arguments);
            const proto = dummy && Object.getPrototypeOf(dummy);
            if (proto &&
                !patchedPrototypes.has(proto) &&
                Object.prototype.hasOwnProperty.call(proto, 'textSizeEx') &&
                typeof proto.textSizeEx === 'function'
            ) {
                const _textSE = proto.textSizeEx;
                proto.textSizeEx = function () {
                    return TranslationManager.disablePluginTrans(() => {
                        _textSE.apply(this, arguments);
                    })
                };
            };
            return dummy;
        };
        Window_Base._jtMNKR_MessageAlignCenterMVPatched = true;
    }

    //MNKR_EnemyIcon.js
    //1.1.0
    //MV
    //append smth after translated string hence breaking cache
    function patch_MNKR_EnemyIcon() {
        if (!$plugins.some(plugin => plugin.status && plugin.name === 'MNKR_EnemyIcon') ||
            Window_BattleEnemy._jtMNKR_EnemyIconPatched
        ) return;
        const _drawI = Window_BattleEnemy.prototype.drawItem;
        Window_BattleEnemy.prototype.drawItem = function () {
            return TranslationManager.fetchTranslatedData(() => {
                return TranslationManager.skipPluginTrans(() => {
                    return _drawI.apply(this, arguments);
                })
            })
        };
        Window_BattleEnemy._jtMNKR_EnemyIconPatched = true;
    }

    TranslationManager._mkrControlProtectionDepth = 0;
    TranslationManager.withMkrControlProtection = function (callback) {
        this._mkrControlProtectionDepth++;
        try {
            return callback();
        } finally {
            this._mkrControlProtectionDepth--;
        }
    };
    const _mkrRegisteredDict = new WeakSet();

    function mkrHasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    };

    //Try Syntax conversion w/o expanding variables
    function toMkrEscapeForm(text) {
        return text.replace(/\\/g, "\x1b").replace(/\x1b\x1b/g, "\\");
    };

    //Return ordered, non overlapping [) intervals
    function scanMkrControlBlocks(text) {
        const blocks = [];
        for (let i = 0; i < text.length;) {
            const prefix = text[i];
            if (prefix !== '\\' && prefix !== '\x1b') {
                i++;
                continue;
            }
            if (text[i + 1] === prefix) {
                i += 2;
                continue;
            }
            const type = text.slice(i + 1, i + 3).toUpperCase();
            if ((type !== 'SE' && type !== 'ME' && type !== 'IM') ||
                text[i + 3] !== '['
            ) {
                i++;
                continue;
            }
            let depth = 1;
            let end = i + 4;
            for (; end < text.length; end++) {
                if (text[end] === '[') {
                    depth++
                } else if (text[end] === ']') {
                    depth--;
                    if (depth === 0) break;
                }
            }
            if (depth !== 0) {
                return { blocks, complete: false };
            }
            end++;
            blocks.push({ start: i, end, type, raw: text.slice(i, end) });
            i = end;
        }
        return { blocks, complete: true };
    }

    function splitMkrControlText(text, blocks) {
        const parts = [];
        let cursor = 0;
        for (const block of blocks) {
            parts.push(text.slice(cursor, block.start));
            cursor = block.end;
        }
        parts.push(text.slice(cursor));
        return parts;
    }

    function sameMkrControlBlock(source, target) {
        return source.type === target.type
        //&& toMkrEscapeForm(source.raw.slice(3)) === toMkrEscapeForm(target.raw.slice(3));
        //don require content consistency in \SE[content] trans dic
    }

    function _registerMKRControlCharacterTrans() {
        if (!TranslationManager._dict ||
            !TranslationManager._lengthKeyDict ||
            _mkrRegisteredDict.has(TranslationManager._dict)
        ) return;
        //wont visit entries added by this registration
        const entries = Object.entries(TranslationManager._dict);
        const KnowTargets = new Set(
            entries.map(entry => entry[1])
        );
        function addTrans(source, target) {
            if (!source ||
                !target ||
                mkrHasOwn(TranslationManager._dict, source)
            ) return;
            TranslationManager._dict[source] = target;
            const bucket = TranslationManager._lengthKeyDict[source.length] || (TranslationManager._lengthKeyDict[source.length] = []);
            if (!bucket.includes(source)) {
                bucket.push(source);
            };
            KnowTargets.add(target);
            TranslationManager._translatedSet.add(target);
            if (!KnowTargets.has(source)) {
                TranslationManager._translatedSet.delete(source);
            }
        }
        for (const [source, target] of entries) {
            if (typeof target !== 'string') continue;
            const sourceScan = scanMkrControlBlocks(source);
            const targetScan = scanMkrControlBlocks(target);
            const sourceBlocks = sourceScan.blocks;
            const targetBlocks = targetScan.blocks;
            if (
                !sourceScan.complete ||
                !targetScan.complete ||
                sourceBlocks.length === 0 ||
                sourceBlocks.length !== targetBlocks.length ||
                !sourceBlocks.every((block, i) => sameMkrControlBlock(block, targetBlocks[i]))
            ) continue;
            const sourceParts = splitMkrControlText(source, sourceBlocks);
            const targetParts = splitMkrControlText(target, targetBlocks);
            for (let i = 0; i < sourceParts.length; i++) {
                addTrans(sourceParts[i], targetParts[i]);
                addTrans(toMkrEscapeForm(sourceParts[i]), toMkrEscapeForm(targetParts[i]));
            }
        }
        _mkrRegisteredDict.add(TranslationManager._dict);
    }

    //MKR_ControlCharacterEx.js
    //1.2.1
    //MV
    //sliceName still not handled
    function patch_MKR_ControlCharacterEx() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            !$plugins.some(plugin => plugin.status && plugin.name === 'MKR_ControlCharacterEx') ||
            Window_Base._jtMKR_ControlCharacterExPatched
        ) return;
        _registerMKRControlCharacterTrans();
        const _translate = TranslationManager.translate;
        TranslationManager.translate = function (text, detectStartWhitespace = true, times = Number.POSITIVE_INFINITY, cache = true, mask = null) {
            if (this._mkrControlProtectionDepth > 0 && typeof text === 'string') {
                //Every wrapper adds masks for this same input before translation.
                const ownMask = scanMkrControlBlocks(text).blocks.map(block => [block.start, block.end]);
                if (ownMask.length > 0) {
                    const args = Array.prototype.slice.call(arguments);
                    args[4] = (mask == null ? [] : mask).concat(ownMask);
                    return _translate.apply(this, args);
                }
            }
            return _translate.apply(this, arguments);
        }

        const _convertEC = Window_Base.prototype.convertEscapeCharacters;
        Window_Base.prototype.convertEscapeCharacters = function (text) {
            if (
                typeof text !== 'string' ||
                TranslationManager._translatedSkipDepth > 0 ||
                TranslationManager._translationDisableDepth > 0
            ) {
                return _convertEC.apply(this, arguments);
            }
            const { blocks } = scanMkrControlBlocks(text);
            if (blocks.length === 0) {
                return _convertEC.apply(this, arguments);
            }
            const result = TranslationManager.withMkrControlProtection(() => {
                return _convertEC.apply(this, arguments);
            });
            if (!TranslationManager.isRawData() && typeof result === 'string') {
                TranslationManager.pushConvertedText(result);
                TranslationManager._pushRecent(result);
            }
            return result;
        }
        Window_Base._jtMKR_ControlCharacterExPatched = true;
    }

    //MOG_SceneMenu.js
    //1.2
    //MV
    function patch_MOG_SceneMenu() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            !$plugins.some(plugin => plugin.status && plugin.name === 'MOG_SceneMenu') ||
            typeof Scene_Menu.prototype.loadBitmapsMain !== 'function' ||
            Scene_Menu._jtMOG_SceneMenuPatched
        ) return;
        TranslationManager._MOG_SceneMenuDepth = 0;
        const patchedInstances = new WeakSet();
        const _createCW = Scene_Menu.prototype.createCommandWindow;
        Scene_Menu.prototype.createCommandWindow = function () {
            TranslationManager._MOG_SceneMenuDepth++;
            try {
                return _createCW.apply(this, arguments);
            } finally {
                TranslationManager._MOG_SceneMenuDepth--;
            }
        };
        const _initialize = Window_MenuCommand.prototype.initialize;
        Window_MenuCommand.prototype.initialize = function () {
            if (TranslationManager._MOG_SceneMenuDepth > 0 &&
                !patchedInstances.has(this) &&
                typeof this.makeCommandList === 'function'
            ) {
                const _makeCL = this.makeCommandList;
                Object.defineProperty(this, 'makeCommandList', {
                    configurable: true,
                    writable: true,
                    enumerable: false,
                    value: function () {
                        return TranslationManager.fetchRawData(() => {
                            return TranslationManager.disablePluginTrans(() => {
                                return _makeCL.apply(this, arguments);
                            })
                        })
                    }
                });
                patchedInstances.add(this);
            }
            return _initialize.apply(this, arguments);
        }
        Scene_Menu._jtMOG_SceneMenuPatched = true;
    }

    //MOG_BattleCommands.js
    //1.3
    //MV
    function patch_MOG_BattleCommands() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            !$plugins.some(plugin => plugin.status && plugin.name === 'MOG_BattleCommands') ||
            typeof Window_ActorCommand.prototype.com_pic_initialize !== 'function' ||
            Window_ActorCommand._jtMOG_BattleCommandsPatched
        ) return;
        TranslationManager._MOG_BattleCommandsDepth = 0;
        const patchedInstances = new WeakSet();
        const _createACW = Scene_Battle.prototype.createActorCommandWindow;
        Scene_Battle.prototype.createActorCommandWindow = function () {
            TranslationManager._MOG_BattleCommandsDepth++;
            try {
                return _createACW.apply(this, arguments);
            } finally {
                TranslationManager._MOG_BattleCommandsDepth--;
            }
        };
        const _initialize = Window_ActorCommand.prototype.initialize;
        Window_ActorCommand.prototype.initialize = function () {
            if (TranslationManager._MOG_BattleCommandsDepth > 0 &&
                !patchedInstances.has(this) &&
                typeof this.makeCommandList === 'function'
            ) {
                const _makeCL = this.makeCommandList;
                Object.defineProperty(this, 'makeCommandList', {
                    configurable: true,
                    writable: true,
                    enumerable: false,
                    value: function () {
                        return TranslationManager.fetchRawData(() => {
                            return TranslationManager.disablePluginTrans(() => {
                                return _makeCL.apply(this, arguments);
                            })
                        })
                    }
                });
                patchedInstances.add(this);
            }
            return _initialize.apply(this, arguments);
        }
        Window_ActorCommand._jtMOG_BattleCommandsPatched = true;
    }

    //MOG_AnimatedText.js
    //1.3
    //MV
    function patch_MOG_AnimatedText() {
        if (Utils.RPGMAKER_NAME !== 'MV' ||
            typeof InfoText === 'undefined' ||
            typeof InfoText.prototype.text !== 'function' ||
            typeof InfoText.prototype.refreshText !== 'function' ||
            typeof InfoText.prototype.loadInfoData !== 'function' ||
            InfoText._jtMOG_AnimatedTextPatched
        ) return;
        const _text = InfoText.prototype.text;
        const _refreshT = InfoText.prototype.refreshText;
        const _loadID = InfoText.prototype.loadInfoData;
        InfoText.prototype.text = function () {
            const source = _text.apply(this, arguments);
            return typeof source === 'string' ? TranslationManager.translate(source) : source;
        }
        InfoText.prototype.refreshText = function () {
            return TranslationManager.skipPluginTrans(() => {
                return _refreshT.apply(this, arguments);
            })
        }
        InfoText.prototype.loadInfoData = function () {
            const data = this.data();
            const saved = data && data[7];
            if (Array.isArray(saved) && Array.isArray(this._letters) && saved.length !== this._letters.length) {
                data[7] = null;
                return;
            }
            return _loadID.apply(this, arguments);
        }
        InfoText._jtMOG_AnimatedTextPatched = true;
    }

    //MOG_AnimatedText.js
    //1.0
    //MZ
    function patch_MOG_AnimatedText_MZ() {
        if (Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof InfoText === 'undefined' ||
            typeof InfoText.prototype.text !== 'function' ||
            typeof InfoText.prototype.refreshText !== 'function' ||
            typeof InfoText.prototype.loadInfoData !== 'function' ||
            InfoText._jtMOG_AnimatedTextMZPatched
        ) return;
        const _text = InfoText.prototype.text;
        const _refreshT = InfoText.prototype.refreshText;
        const _loadID = InfoText.prototype.loadInfoData;
        InfoText.prototype.text = function () {
            const source = _text.apply(this, arguments);
            if (typeof source !== 'string') return;
            let padded = source.length % 2 === 0;
            for (let i = 1; padded && i < source.length; i += 2) {
                if (source[i] !== ' ') padded = false;
            }
            if (!padded) return TranslationManager.translate(source);
            let raw = '';
            for (let i = 0; i < source.length; i += 2) {
                raw += source[i];
            }
            const translated = TranslationManager.translate(raw);
            let result = '';
            for (let i = 0; i < translated.length; i++) {
                result += translated[i] + ' ';
            }
            return result;
        };
        InfoText.prototype.refreshText = function () {
            return TranslationManager.skipPluginTrans(() => {
                return _refreshT.apply(this, arguments);
            })
        }
        InfoText.prototype.loadInfoData = function () {
            const data = this.data();
            const saved = data && data[7];
            if (Array.isArray(saved) && Array.isArray(this._letters) && saved.length !== this._letters.length) {
                data[7] = null;
                return;
            }
            return _loadID.apply(this, arguments);
        }
        InfoText._jtMOG_AnimatedTextMZPatched = true;
    }

    //MOG_TimeSystem.js
    //1.6
    //MV
    function patch_MOG_TimeSystem() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Window_Time_Status === 'undefined' ||
            typeof Moghunter === 'undefined' ||
            Window_Time_Status._jtMOG_TimeSystemPatched
        ) return;
        const fields = [
            "time_word",
            "day_word",
            "day_week_word",
            "month_word",
            "season_word",
            "year_word",
            "play_time_word"
        ];
        fields.forEach(function (key) {
            if (Moghunter[key] instanceof String) {
                Moghunter[key] = String(Moghunter[key]);
            }
        })
        Window_Time_Status._jtMOG_TimeSystemPatched = true;
    }

    //MOG_Music_Book.js
    //1.5
    //MV
    //mirroring setText_rv, might be version dependent
    function patch_MOG_Music_Book() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Window_Help.prototype.setText_rv !== 'function' ||
            Window_Help._jtMOG_Music_BookPatched
        ) return;
        Window_Help.prototype.setText_rv = function (text) {
            if (this._text === text) return;
            const displayText = TranslationManager.translate(text);
            return TranslationManager.skipPluginTrans(() => {
                const words = displayText.split(' ');
                let text1 = '';
                let text2 = '';
                for (let i = 0; i < words.length; i++) {
                    if (this.textWidth(text1 + words[i]) < this.width - 32) {
                        text1 += words[i] + ' ';
                    } else {
                        text2 += words[i] + ' ';
                    }
                }
                this._text = text;
                this.contents.clear();
                this.drawText(text1, 0, 0, this.width - 32);
                this.drawText(text2, 0, this.lineHeight(), this.width - 32);
            })
        }
        Window_Help._jtMOG_Music_BookPatched = true;
    }

    //MOG_TreasurePopup.js
    //1.1
    //MV
    function patch_MOG_TreasurePopup() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof TreasureIcons === 'undefined' ||
            TreasureIcons._jtMOG_TreasurePopupPatched
        ) return;
        ['setupNew', 'refreshName'].forEach(function (key) {
            const ori = TreasureIcons.prototype[key];
            TreasureIcons.prototype[key] = function () {
                return TranslationManager.skipPluginTrans(() => {
                    return ori.apply(this, arguments);
                })
            }
        });
        TreasureIcons._jtMOG_TreasurePopupPatched = true;
    }

    //MOG_TreasurePopup.js
    //1.1
    //MZ
    function patch_MOG_TreasurePopup_MZ() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof TreasureIcons === 'undefined' ||
            TreasureIcons._jtMOG_TreasurePopupMZPatched
        ) return;
        ['setupNew', 'refreshName'].forEach(function (key) {
            const ori = TreasureIcons.prototype[key];
            TreasureIcons.prototype[key] = function () {
                const item = key === 'setupNew' ? arguments[0] && arguments[0][0] : this._item;
                if (!TranslationManager.getDataFieldState(item, 'name')) {
                    return ori.apply(this, arguments);
                }//cache after reloading save isnt dynamic structure
                return TranslationManager.skipPluginTrans(() => {
                    return ori.apply(this, arguments);
                })
            }
        });
        TreasureIcons._jtMOG_TreasurePopupMZPatched = true;
    }

    //MOG_TreasureHud.js
    //1.3
    //MV
    function patch_MOG_TreasureHud() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Treasure_Hud === 'undefined' ||
            typeof Treasure_Hud.prototype.refresh_name !== 'function' ||
            Treasure_Hud._jtMOG_TreasureHudPatched
        ) return;
        const _refreshN = Treasure_Hud.prototype.refresh_name;
        Treasure_Hud.prototype.refresh_name = function () {
            return TranslationManager.skipPluginTrans(() => {
                return _refreshN.apply(this, arguments);
            })
        };
        Treasure_Hud._jtMOG_TreasureHudPatched = true;
    }

    //MOG_TreasureHud.js
    //1.1
    //MZ
    function patch_MOG_TreasureHud_MZ() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Treasure_Hud === 'undefined' ||
            typeof Treasure_Hud.prototype.refresh_name !== 'function' ||
            Treasure_Hud._jtMOG_TreasureHudMZPatched
        ) return;
        const _refreshN = Treasure_Hud.prototype.refresh_name;
        Treasure_Hud.prototype.refresh_name = function () {
            const item = this.item();
            if (!item || typeof item !== 'object' || !TranslationManager.getDataFieldState(item, 'name')) {
                return _refreshN.apply(this, arguments);
            }
            return TranslationManager.skipPluginTrans(() => {
                return _refreshN.apply(this, arguments);
            })
        };
        Treasure_Hud._jtMOG_TreasureHudMZPatched = true;
    }

    //MOG_BattleCursor.js
    //1.0
    //MZ
    function patch_MOG_BattleCursor() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Spriteset_Battle.prototype.createBattleCursor !== 'function' ||
            Spriteset_Battle._jtMOG_BattleCursorPatched
        ) return;
        const patchedPrototypes = new WeakSet();
        const _createBC = Spriteset_Battle.prototype.createBattleCursor;
        function hasBoundDisplayName(battler) {
            if (!battler) return false;
            const target = battler.isEnemy() ? battler.enemy() : battler;
            const key = battler.isEnemy() ? 'name' : '_name';
            const field = TranslationManager.getDataFieldState(target, key);
            if (!field) return false;
            if (field.compareWithDatabaseRaw && TranslationManager.getRawData(target, key) !== field.databaseRaw) return false;
            return true;
        }
        Spriteset_Battle.prototype.createBattleCursor = function () {
            const previousChild = new Set(this._sprtField2 ? this._sprtField2.children : []);
            const result = _createBC.apply(this, arguments);
            for (const sprite of this._sprtField2.children) {
                if (
                    previousChild.has(sprite) ||
                    sprite._spriteset !== this ||
                    !sprite._battlerSprite
                ) continue;
                const proto = Object.getPrototypeOf(sprite);
                if (patchedPrototypes.has(proto) || typeof proto.refreshName !== 'function') continue;
                const _refreshN = proto.refreshName;
                proto.refreshName = function () {
                    if (!hasBoundDisplayName(this._battler)) {
                        return _refreshN.apply(this, arguments);
                    }
                    return TranslationManager.skipPluginTrans(() => {
                        return _refreshN.apply(this, arguments);
                    })
                }
                patchedPrototypes.add(proto);
            }
            return result;
        }
        Spriteset_Battle._jtMOG_BattleCursorPatched = true;
    }

    //TMTyping.js
    //1.1
    //MV
    function patch_TMTyping() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_Message.prototype.kanaToRoma !== 'function' ||
            typeof Window_Options.prototype.addTypingOptions !== 'function' ||
            Game_Message._jtTMTypingPatched
        ) return;
        const Symbols = new Set([
            'typingSI', 'typingTI', 'typingTU', 'typingHU',
            'typingNN', 'typingJI', 'typingSHA', 'typingJA', 'typingCHA'
        ]);
        const _addTO = Window_Options.prototype.addTypingOptions;
        Window_Options.prototype.addTypingOptions = function () {
            return TranslationManager.disablePluginTrans(() => {
                return _addTO.apply(this, arguments);
            })
        };
        const _drawI = Window_Options.prototype.drawItem;
        Window_Options.prototype.drawItem = function (index) {
            if (!Symbols.has(this.commandSymbol(index))) {
                return _drawI.apply(this, arguments);
            }
            const rect = this.itemRectForText(index);
            const statusWidth = this.statusWidth();
            const titleWidth = rect.width - statusWidth;
            this.resetTextColor();
            this.changePaintOpacity(this.isCommandEnabled(index));
            this.drawText(
                this.commandName(index),
                rect.x, rect.y, titleWidth, 'left'
            );
            return TranslationManager.disablePluginTrans(() => {
                return this.drawText(this.statusText(index), titleWidth, rect.y, statusWidth, 'right')
            })
        };
        const patchedPrototypes = new WeakSet();
        function romaProtect(proto, name) {
            const ori = proto[name];
            if (typeof ori !== 'function') return;
            proto[name] = function () {
                return TranslationManager.disablePluginTrans(() => {
                    return ori.apply(this, arguments);
                })
            }
        };
        const _createSW = Window_Message.prototype.createSubWindows;
        Window_Message.prototype.createSubWindows = function () {
            const result = _createSW.apply(this, arguments);
            const tWindow = this._typingWindow;
            if (!tWindow) return result;
            const proto = Object.getPrototypeOf(tWindow);
            if (!patchedPrototypes.has(proto)) {
                romaProtect(proto, 'textWidthEx');
                romaProtect(proto, 'refreshRoma');
                patchedPrototypes.add(proto);
            }
            return result;
        }
        Game_Message._jtTMTypingPatched = true;
    }

    //TMAnimeLight.js
    //2.0.1
    //MV
    //sanely possible filename smh
    function patch_TMAnimeLight() {
        if (
            typeof Game_Temp.prototype.createAnimeLightSinTable !== 'function' ||
            Utils.RPGMAKER_NAME !== 'MV' ||
            Game_Temp._jtTMAnimeLightPatched ||
            typeof Game_Interpreter.prototype.convertEscapeCharactersTM !== 'function'
        ) return;
        const active = new WeakSet();
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        const _convertECTM = Game_Interpreter.prototype.convertEscapeCharactersTM;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            const wasActive = active.has(this);
            if (command === 'animeLight') active.add(this);
            else active.delete(this);
            try {
                return _pluginC.apply(this, arguments);
            } finally {
                if (wasActive) active.add(this);
                else active.delete(this);
            }
        };
        Game_Interpreter.prototype.convertEscapeCharactersTM = function () {
            if (!active.has(this)) {
                return _convertECTM.apply(this, arguments);
            }
            return TranslationManager.fetchRawData(() => {
                return _convertECTM.apply(this, arguments);
            })
        }
        Game_Temp._jtTMAnimeLightPatched = true;
    }

    //TMGoogleMaps.js
    //2.0
    //MV
    //Ive seen zero use case tbf
    function patch_TMGoogleMaps() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_Temp.prototype.geoCoding !== 'function' ||
            Game_Temp._jtTMGoogleMapsPatched
        ) return;
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (command === 'geoCoding' && args && args[0] === 'actor') {
                return TranslationManager.fetchRawData(() => {
                    return _pluginC.apply(this, arguments);
                })
            }
            return _pluginC.apply(this, arguments);
        }
        Game_Temp._jtTMGoogleMapsPatched = true;
    }

    //TMLogWindow.js
    //1.1.1
    //MV
    //not quite confident abt this
    //also TMJALogWindow.js
    //0.1b
    function patch_TMLogWindow() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Scene_Map.prototype.createMapLogWindow !== 'function' ||
            Game_System._jtTMLogWindowPatched
        ) return;
        const wrappedWindows = new WeakSet();
        function _protectWindow(window) {
            if (wrappedWindows.has(window)) return;
            const _drawTextEx = window.drawTextEx;
            if (typeof _drawTextEx !== 'function') return;
            window.drawTextEx = function () {
                return TranslationManager.skipPluginTrans(() => {
                    return _drawTextEx.apply(this, arguments);
                })
            }
            wrappedWindows.add(window);
        }
        function _captureWindow(baseProto, callback) {
            const _initialize = baseProto.initialize;
            function wrappedInitialize() {
                _protectWindow(this);
                return _initialize.apply(this, arguments);
            }
            baseProto.initialize = wrappedInitialize;
            try {
                return callback();
            } finally {
                baseProto.initialize = _initialize;
            }
        }
        const _createMLW = Scene_Map.prototype.createMapLogWindow;
        Scene_Map.prototype.createMapLogWindow = function () {
            return _captureWindow(Window_Base.prototype, () => { return _createMLW.apply(this, arguments) });
        }
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (command !== 'openLogScene') {
                return _pluginC.apply(this, arguments);
            }
            const _push = SceneManager.push;
            SceneManager.push = function (sceneClass) {
                _protectLogSceneClass(sceneClass);
                return _push.apply(this, arguments);
            }
            try {
                return _pluginC.apply(this, arguments);
            } finally {
                SceneManager.push = _push;
            }
        }
        const wrappedScenes = new WeakSet();
        function _protectLogSceneClass(sceneClass) {
            const proto = sceneClass && sceneClass.prototype;
            if (
                !proto ||
                wrappedScenes.has(proto) ||
                typeof proto.createCreditsWindow !== 'function'
            ) return;
            const _createCreditsWindow = proto.createCreditsWindow;
            proto.createCreditsWindow = function () {
                return _captureWindow(Window_Selectable.prototype, () => { return _createCreditsWindow.apply(this, arguments) });
            }
            wrappedScenes.add(proto);
        }
        Game_System._jtTMLogWindowPatched = true;
    }

    //TMNamePop.js
    //2.0.0
    //MV
    function patch_TMNamePop() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_CharacterBase.prototype.setNamePop !== 'function' ||
            typeof Game_Interpreter.prototype.convertEscapeCharactersTM !== 'function' ||
            Game_CharacterBase._jtTMNamePopPatched
        ) return;
        const _setNP = Game_CharacterBase.prototype.setNamePop;
        Game_CharacterBase.prototype.setNamePop = function () {
            return TranslationManager.fetchRawData(() => {
                return _setNP.apply(this, arguments);
            })
        };
        const active = new WeakSet();
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        const _convertECTM = Game_Interpreter.prototype.convertEscapeCharactersTM;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            const wasActive = active.has(this);
            if (command === 'namePop') active.add(this);
            else active.delete(this);
            try {
                return _pluginC.apply(this, arguments);
            } finally {
                if (wasActive) active.add(this);
                else active.delete(this);
            }
        }
        Game_Interpreter.prototype.convertEscapeCharactersTM = function () {
            if (!active.has(this)) {
                return _convertECTM.apply(this, arguments);
            }
            return TranslationManager.fetchRawData(() => {
                return _convertECTM.apply(this, arguments);
            })
        }
        Game_CharacterBase._jtTMNamePopPatched = true;
    }

    //YEP_AdvSwVar.js
    //1.0.2
    //MV
    function patch_YEP_AdvSwVar() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_Switches.prototype.isAdvancedSwitch !== 'function' ||
            typeof Game_Switches.prototype.runAdvancedSwitchCode !== 'function' ||
            typeof Game_Variables.prototype.isAdvancedVariable !== 'function' ||
            typeof Game_Variables.prototype.runAdvancedVariableCode !== 'function' ||
            Game_Variables._jtYEP_AdvSwVarPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        Game_Switches.prototype.isAdvancedSwitch = wrapRaw(Game_Switches.prototype.isAdvancedSwitch);
        Game_Switches.prototype.runAdvancedSwitchCode = wrapRaw(Game_Switches.prototype.runAdvancedSwitchCode);
        Game_Variables.prototype.isAdvancedVariable = wrapRaw(Game_Variables.prototype.isAdvancedVariable);
        Game_Variables.prototype.runAdvancedVariableCode = wrapRaw(Game_Variables.prototype.runAdvancedVariableCode);
        Game_Variables._jtYEP_AdvSwVarPatched = true;
    }

    //YEP_SelfSwVar.js
    //1.04
    //MV
    function patch_YEP_SelfSwVar() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof DataManager.isSelfSwitch !== 'function' ||
            typeof DataManager.isSelfVariable !== 'function' ||
            DataManager._jtYEP_SelfSwVarPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        DataManager.isSelfSwitch = wrapRaw(DataManager.isSelfSwitch);
        DataManager.isSelfVariable = wrapRaw(DataManager.isSelfVariable);
        DataManager._jtYEP_SelfSwVarPatched = true;
    }

    TranslationManager.withPreparedDisplayText = function (callback) {
        return this.skipPluginTrans(callback);
    };
    //Ask AI not me :/
    //YEP_MessageCore.js
    //1.19
    //MV
    //actually for several plugin complex
    function patch_YEP_MessageCore() {
        if (Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_MessageCore ||
            TranslationManager._jtYEPMessagePatched) return;
        const _BconvertEC = Window_Base.prototype.convertEscapeCharacters;
        const _MconvertEC = Window_Message.prototype.convertEscapeCharacters;
        const _id = String.raw`(?:\d+|\\V\[\d+\])`;
        const _emit = String.raw`(?:AC|AN|PC|PN|NC|NI|NW|NA|NE|NS|NT|II|IW|IA|IS|IT|MAP|EN|ET)\[${_id}\]|G`;
        const _param = String.raw`(?:Q[IWA]|[AE](?:LVL|MHP|HP%?|MMP|MP%?|MTP|TP%?|ATK|DEF|MAT|MDF|AGI|LUK|HIT|EVA|CRI|CEV|MEV|MRF|CNT|HRG|MRG|TRG|TGR|GRD|REC|PHA|MCR|TCR|PDR|MDR|FDR|EXR|EXP|GOLD))\[${_id}\]`;
        const _controls = String.raw`COMPARE\d*<.*?:.*?>|${_emit}|${_param}|FN<.*?>|LSN<.*?>|EVALTEXT<<.*?>>|CASE(?:EVAL|SWITCH)\{.*?\}|(?:MSGPOSX|MSGPOSY|MSGROWS|MSGWIDTH)\[.*?\]`;
        const _logicRE = () => new RegExp(
            String.raw`[\\\x1b](?:${_controls}|M\[.*?\])|<(?:WordWrap|BR|line break)>`,
            'gi'
        );
        const _tokenRE = () => new RegExp(String.raw`\\(?:${_controls})`, 'gi');
        let _frame = null;
        let _serial = 0;
        let _replayInput = 0;
        TranslationManager.withPreparedDisplayText = function (callback) {
            _replayInput++;
            try {
                return TranslationManager.skipPluginTrans(callback);
            } finally {
                _replayInput--;
            }
        };
        let _fragmentDepth = 0;
        function _matches(text, re) {
            const copy = new RegExp(re.source, re.flags);
            const out = [];
            let m;
            while ((m = copy.exec(text))) {
                out.push(m);
                if (!m[0]) copy.lastIndex++;
            }
            return out;
        }
        function _live(s, index) {
            let count = 0;
            while (index > 0 && s[--index] === '\\') count++;
            return count % 2 === 0;
        }
        function _protectedMatches(text) {
            const result = _matches(text, _logicRE())
                .filter(m => _live(text, m.index));
            if (Yanfly.Param.QuickMacro && Yanfly.MsgMacroArr) {
                const escaped = text.replace(/\\/g, '\x1b')
                    .replace(/\x1b\x1b/g, '\uE002\uE002');
                for (const re of Yanfly.MsgMacroArr) {
                    if (!re) continue;
                    for (const m of _matches(escaped, re)) {
                        result.push({
                            0: text.slice(m.index, m.index + m[0].length),
                            index: m.index
                        });
                    }
                }
            }
            return result;
        }
        const _translate = TranslationManager.translate;
        TranslationManager.translate = function (
            text, spaces = true, times = Infinity, cache = true, mask = null
        ) {
            if (typeof text !== 'string') {
                return _translate.apply(this, arguments);
            }
            const spans = _protectedMatches(text);
            if (!spans.length) return _translate.apply(this, arguments);
            const candidate = this._dict && this._dict[text];
            const same = typeof candidate === 'string' &&
                JSON.stringify(spans.map(m => m[0])) ===
                JSON.stringify(_protectedMatches(candidate).map(m => m[0]));
            if (same && (!mask || !mask.length)) {
                return _translate.call(this, text, spaces, times, cache, mask);
            }
            const ranges = (Array.isArray(mask) ? mask : []).concat(
                spans.map(m => [m.index, m.index + m[0].length])
            );
            return _translate.call(this, text, spaces, times, cache, ranges);
        };
        const _setWordWrap = Window_Base.prototype.setWordWrap;
        Window_Base.prototype.setWordWrap = function (text) {
            return _fragmentDepth ? text : _setWordWrap.call(this, text);
        };
        function _rawConvert(win, text) {
            _fragmentDepth++;
            try {
                return TranslationManager.fetchRawData(() =>
                    TranslationManager.disablePluginTrans(() => _BconvertEC.call(win, text))
                );
            } finally {
                _fragmentDepth--;
            }
        }
        function _sourceTranslate(text) {
            const flags = text.split('\n')
                .map(line => /<WordWrap>/i.test(line));
            const wrapped = flags.some(Boolean);
            const direct = TranslationManager._dict && TranslationManager._dict[text];
            let output = typeof direct === 'string' &&
                wrapped === /<WordWrap>/i.test(direct)
                ? TranslationManager.translate(text)
                : TranslationManager.translate(text.replace(/<WordWrap>/gi, ''));
            output = output.replace(/<WordWrap>/gi, '');
            if (!wrapped) return output;
            if (_frame && _frame.snapshot) {
                const lines = output.split('\n');
                const allWrapped = flags.every(Boolean);
                if (allWrapped || flags.length === lines.length) {
                    return lines.map((line, i) =>
                        (allWrapped || flags[i] ? '<WordWrap>' : '') + line
                    ).join('\n');
                }
            }
            return '<WordWrap>' + output;
        }
        function _quickOverlaps(text, start, end) {
            if (!Yanfly.Param.QuickMacro || !Yanfly.MsgMacroArr) {
                return false;
            }
            const escaped = text
                .replace(/\\/g, '\x1b')
                .replace(/\x1b\x1b/g, '\uE002\uE002');
            return Yanfly.MsgMacroArr.some(re =>
                re && _matches(escaped, re).some(m =>
                    m.index < end &&
                    m.index + m[0].length > start
                )
            );
        }
        function _rawMacroSelectors(win, text) {
            const v1 = String.raw`\\V\[\d+\]`;
            const v2 = String.raw`\\V\[(?:\d+|${v1})\]`;
            const control = String.raw`\\(?:V\[(?:\d+|${v1})\]|[NP]\[(?:\d+|${v1}|${v2})\])`;
            const re = new RegExp(
                String.raw`\\M\[((?:${control}|[^\[\]\r\n])*)\]`,
                'gi'
            );
            return text.replace(re, (all, selector) => {
                if (!/\\[VNP]\[/i.test(selector)) return all;
                const name = TranslationManager.fetchRawData(() =>
                    TranslationManager.disablePluginTrans(() => {
                        const variable = (match, id) =>
                            $gameVariables.value(parseInt(id, 10));
                        return selector
                            .replace(/\\V\[(\d+)\]/gi, variable)
                            .replace(/\\V\[(\d+)\]/gi, variable)
                            .replace(/\\N\[(\d+)\]/gi, (match, id) =>
                                win.actorName(parseInt(id, 10)))
                            .replace(/\\P\[(\d+)\]/gi, (match, id) =>
                                win.partyMemberName(parseInt(id, 10)));
                    })
                );
                if (/^\d+$/.test(name)) return '\\M[' + name + ']';
                const id = Yanfly.MsgMacroRef[name.toUpperCase()];
                return id ? '\\M[' + id + ']' : all;
            });
        }
        const _nameRE = () =>
            /\\(N[1-5]?|NC|NR|ND[1-5]?|NDC|NDR|NT[1-5]?|NTC|NTR)<((?:\\EVALTEXT<<.*?>>|\\CASE(?:EVAL|SWITCH)\{.*?\}|[^\r\n>])*?)>/gi;
        function _prepare(win, text, context, internal, translated = false) {
            if (internal) text = text.replace(/\x1b/g, '\\');
            const rawNames = _matches(text, _nameRE())
                .filter(m => _live(text, m.index) &&
                    !_quickOverlaps(text, m.text, m.index + m[0].length)
                );
            let output = translated ? text : _sourceTranslate(text);
            if (!internal && !context.snapshot) {
                output = _rawMacroSelectors(win, output);
            };
            let nameIndex = 0;
            if (context.message) {
                output = output.replace(
                    _nameRE(), (all, kind, display, offset, whole) => {
                        if (!_live(whole, offset) || _quickOverlaps(whole, offset, offset + all.length)) return all;
                        const raw = rawNames[nameIndex++];
                        if (!raw ||
                            raw[1].toUpperCase() !== kind.toUpperCase()) {
                            throw new Error('Name code structure changed');
                        }
                        const key = 'JTNAME' + (++_serial);
                        const rawName = _rawConvert(win, raw[2]);
                        context.names.set(key, {
                            raw: rawName,
                            display: TranslationManager.translate(
                                display === raw[2]
                                    ? rawName
                                    : _rawConvert(win, display)
                            )
                        });
                        return '\\' + kind + '<' + key + '>';
                    }
                );
            }
            output = output.replace(_tokenRE(), (raw, offset, whole) => {
                if (!_live(whole, offset) || _quickOverlaps(whole, offset, offset + raw.length)) return raw;
                const key = '\uE000JTX' + (++_serial) + '\uE001';
                const kind =
                    /^\\(?:(?:AC|AN|PC|PN|NC|NI|NW|NA|NE|NS|NT|II|IW|IA|IS|IT|MAP|EN|ET)\[|G)/i.test(raw)
                        ? 'emit'
                        : /^\\COMPARE/i.test(raw) ? 'compare'
                            : /^\\Q/i.test(raw) ? 'quantity'
                                : /^\\A/i.test(raw) ? 'actor'
                                    : /^\\E(?!VALTEXT)/i.test(raw) ? 'enemy'
                                        : /^\\CASESWITCH/i.test(raw) ? 'switch'
                                            : /^\\CASEEVAL/i.test(raw) ? 'case'
                                                : /^\\EVALTEXT/i.test(raw) ? 'eval'
                                                    : 'resource';
                context.pending.set(key, { raw, kind });
                return key;
            });
            return internal ? output.replace(/\\/g, '\x1b') : output;
        }
        function _resolve(win, text, context, kind) {
            return text.replace(/\uE000JTX\d+\uE001/g, key => {
                const item = context.pending.get(key);
                if (!item || item.kind !== kind) return key;
                const value = _rawConvert(win, item.raw);
                return kind === 'resource' ? value : TranslationManager.translate(value);
            });
        }
        Window_Message.prototype.convertEscapeCharacters = function (text) {
            if (TranslationManager._translationDisableDepth || TranslationManager._translatedSkipDepth) {
                return _MconvertEC.call(this, text);
            }
            const previous = _frame;
            _frame = { message: true, names: new Map(), pending: new Map() };
            try {
                return _MconvertEC.call(this, text);
            } finally {
                _frame = previous;
            }
        };
        Window_Base.prototype.convertEscapeCharacters = function (text) {
            if (TranslationManager._translationDisableDepth ||
                (TranslationManager._translatedSkipDepth && !_replayInput)) {
                return _BconvertEC.call(this, text);
            }
            const previous = _frame;
            if (!_frame) {
                _frame = { message: false, names: new Map(), pending: new Map() };
            }
            try {
                const prepared = _prepare(
                    this, text, _frame, false, !!_replayInput
                );
                let result = TranslationManager.skipPluginTrans(() => {
                    return TranslationManager.enableValueTrans(() => {
                        return _BconvertEC.call(this, prepared);
                    })
                });
                result = _resolve(this, result, _frame, 'resource');
                result = _resolve(this, result, _frame, 'eval');
                TranslationManager.pushConvertedText(result);
                return result;
            } finally {
                _frame = previous;
            }
        };
        const _convertEEC = Window_Base.prototype.convertExtraEscapeCharacters;
        Window_Base.prototype.convertExtraEscapeCharacters = function (text) {
            const result = _convertEEC.call(this, text);
            return _frame && !TranslationManager._translationDisableDepth
                ? _resolve(this, result, _frame, 'emit')
                : result;
        };
        if (Window_Base.prototype.convertCaseText) {
            const _convertCT = Window_Base.prototype.convertCaseText;
            Window_Base.prototype.convertCaseText = function (text) {
                if (!_frame || TranslationManager._translationDisableDepth) {
                    return _convertCT.call(this, text);
                }
                const result = TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _convertCT.call(this, text);
                    })
                });
                return _resolve(
                    this, _resolve(this, result, _frame, 'switch'), _frame, 'case'
                );
            };
        }
        for (const [method, kind] of [
            ['convertItemQuantitiesCodes', 'quantity'],
            ['convertActorParameterCodes', 'actor'],
            ['convertEnemyParameterCodes', 'enemy'],
            ['convertColorCompare', 'compare']
        ]) {
            const ori = Window_Base.prototype[method];
            if (typeof ori !== 'function') continue;
            Window_Base.prototype[method] = function (text) {
                if (!_frame || TranslationManager._translationDisableDepth) {
                    return ori.call(this, text);
                }
                return _resolve(this, ori.call(this, text), _frame, kind);
            };
        }
        function _wrapRefresh(owner, key) {
            const ori = owner && owner[key];
            if (typeof ori !== 'function') return;
            owner[key] = function (text) {
                if (TranslationManager._translationDisableDepth) {
                    return ori.apply(this, arguments);
                }
                const named = _frame && _frame.names.get(text);
                if (TranslationManager._translatedSkipDepth && !named) {
                    return ori.apply(this, arguments);
                }
                const pair = named || { raw: text, display: TranslationManager.translate(text) };
                const args = Array.prototype.slice.call(arguments);
                args[0] = pair.display;
                const previousFrame = _frame;
                const format = Yanfly.Param.MSGNameBoxText;
                const prefix = _sourceTranslate(format);
                _frame = null;
                _replayInput++;
                try {
                    Yanfly.Param.MSGNameBoxText =
                        Window_Base.prototype.convertEscapeCharacters.call(this, prefix);
                } finally {
                    _replayInput--;
                    _frame = previousFrame;
                }
                _frame = null;
                try {
                    const result = TranslationManager.skipPluginTrans(() =>
                        ori.apply(this, args)
                    );
                    this._lastNameText = pair.raw;
                    return result;
                } finally {
                    _frame = previousFrame;
                    Yanfly.Param.MSGNameBoxText = format;
                }
            };
        }
        for (const key of ['refresh', 'refreshDimmed', 'refreshTransparent']) {
            _wrapRefresh(Window_NameBox.prototype, key);
        }
        if (Yanfly.EMP1) {
            _wrapRefresh(Yanfly.EMP1, 'Window_NameBox_refresh');
        }
        if (Window_Message.prototype.hasDifferentNameBoxText) {
            const ori = Window_Message.prototype.hasDifferentNameBoxText;
            Window_Message.prototype.hasDifferentNameBoxText = function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return ori.apply(this, arguments);
                    })
                });
            };
        }
        for (const key of [
            'actorClassName', 'partyClassName',
            'actorNickname', 'partyNickname'
        ]) {
            const ori = Window_Base.prototype[key];
            Window_Base.prototype[key] = function () {
                const value = ori.apply(this, arguments);
                return TranslationManager._translationDisableDepth ? value : TranslationManager.translate(value);
            };
        }
        function _replay(owner, key) {
            const ori = owner[key];
            if (typeof ori !== 'function') return;
            owner[key] = function () {
                return TranslationManager.skipPluginTrans(() => ori.apply(this, arguments));
            };
        }
        _replay(Window_Base.prototype, 'textWidthExCheck');
        _replay(Window_Base.prototype, 'processNormalCharacter');
        _replay(Window_Message.prototype, 'getFittedMessageRows');
        _replay(Window_Message.prototype, 'getFittedMessageWidth');
        if (Window_Base.prototype.convertMacroText) {
            const ori = Window_Base.prototype.convertMacroText;
            Window_Base.prototype.convertMacroText = function () {
                if (!_frame || TranslationManager._translationDisableDepth) {
                    return ori.apply(this, arguments);
                }
                const context = _frame;
                const win = this;
                const table = Yanfly.MsgMacro;
                Yanfly.MsgMacro = new Proxy(table, {
                    get(target, key) {
                        const value = target[key];
                        return !TranslationManager._translationDisableDepth &&
                            typeof value === 'string' &&
                            /^\d+$/.test(String(key))
                            ? _prepare(win, value, context, true)
                            : value;
                    }
                });
                try {
                    return ori.apply(this, arguments);
                } finally {
                    Yanfly.MsgMacro = table;
                }
            };
        }
        if (typeof Window_MessageBacklog !== 'undefined') {
            const _convertMT = Window_MessageBacklog.prototype.convertMessageText;
            const _removeMBOC = Window_MessageBacklog.prototype.removeMessageBoxOnlyCodes;
            const _convertNC = Window_MessageBacklog.prototype.convertNameboxCodes;
            const _backlogASC = Window_ChoiceList.prototype.backlogAddSelectedChoice;
            let preparedInput = 0;
            function _known() {
                return $gameSystem._jtYEPBacklogPrepared ||
                    ($gameSystem._jtYEPBacklogPrepared = []);
            }
            Window_MessageBacklog.prototype.convertNameboxCodes = function (text) {
                if (!_frame || !_frame.snapshot || TranslationManager._translationDisableDepth) {
                    return _convertNC.call(this, text);
                }
                const format = Yanfly.Param.MSGNameBoxText;
                Yanfly.Param.MSGNameBoxText =
                    _prepare(this, format, _frame, false);
                try {
                    return _convertNC.call(this, text);
                } finally {
                    Yanfly.Param.MSGNameBoxText = format;
                }
            };
            Window_MessageBacklog.prototype.removeMessageBoxOnlyCodes = function (text) {
                if (!_frame || !_frame.snapshot || TranslationManager._translationDisableDepth) {
                    return _removeMBOC.call(this, text);
                }
                text = text.replace(/\uE000JTX\d+\uE001/g, key => {
                    const item = _frame.pending.get(key);
                    if (!item) return key;
                    if (item.kind === 'emit' && /^\\G$/i.test(item.raw)) {
                        return TranslationManager.translate(TextManager.currencyUnit);
                    }
                    return TranslationManager.fetchRawData(() => {
                        return TranslationManager.disablePluginTrans(() => {
                            return _convertMT.call(this, item.raw);
                        })
                    });
                });
                return _removeMBOC.call(this, text);
            };
            Window_MessageBacklog.prototype.convertMessageText = function (text) {
                if (TranslationManager._translationDisableDepth) {
                    return _convertMT.call(this, text);
                }
                if (_known().includes(text)) return text;
                const previous = _frame;
                _frame = {
                    message: false,
                    names: new Map(),
                    pending: new Map(),
                    snapshot: true
                };
                try {
                    const source = _prepare(
                        this, text, _frame, false, preparedInput > 0
                    );
                    const output = TranslationManager.skipPluginTrans(() => {
                        return TranslationManager.enableValueTrans(() => {
                            return _convertMT.call(this, source);
                        })
                    });
                    const records = _known();
                    records.push(output);
                    const limit = Math.max(
                        128, 2 * Yanfly.Param.MsgBacklogMaxEntries
                    );
                    while (records.length > limit) records.shift();
                    return output;
                } finally {
                    _frame = previous;
                }
            };
            Window_ChoiceList.prototype.backlogAddSelectedChoice = function () {
                const _ownCommandName = Object.getOwnPropertyDescriptor(this, 'commandName');
                const _commandName = this.commandName;
                this.commandName = function () {
                    return TranslationManager.translate(_commandName.apply(this, arguments));
                };
                try {
                    return _backlogASC.apply(this, arguments);
                } finally {
                    if (_ownCommandName) {
                        Object.defineProperty(this, 'commandName', _ownCommandName);
                    } else {
                        delete this.commandName;
                    }
                }
            };
            for (const key of ['addIndividualLines', 'drawItem']) {
                const ori = Window_MessageBacklog.prototype[key];
                Window_MessageBacklog.prototype[key] = function () {
                    _replayInput++;
                    try {
                        return TranslationManager.skipPluginTrans(() =>
                            ori.apply(this, arguments)
                        );
                    } finally {
                        _replayInput--;
                    }
                };
            }
            for (const proto of [
                Window_ChoiceList.prototype,
                Window_NumberInput.prototype,
                Window_EventItem.prototype
            ]) {
                const ori = proto.backlogAddSelectedChoice;
                if (typeof ori !== 'function') continue;
                proto.backlogAddSelectedChoice = function () {
                    const format = Yanfly.Param.MsgBacklogSpcFmt;
                    Yanfly.Param.MsgBacklogSpcFmt = _sourceTranslate(format);
                    preparedInput++;
                    try {
                        return TranslationManager.skipPluginTrans(() =>
                            ori.apply(this, arguments)
                        );
                    } finally {
                        preparedInput--;
                        Yanfly.Param.MsgBacklogSpcFmt = format;
                    }
                };
            }
            const _initMB = Game_System.prototype.initMessageBacklog;
            Game_System.prototype.initMessageBacklog = function () {
                const result = _initMB.apply(this, arguments);
                this._jtYEPBacklogPrepared = [];
                return result;
            };
        }
        TranslationManager._jtYEPMessagePatched = true;
    }

    //YEP_SaveCore.js
    //1.06
    //MV
    function patch_YEP_SaveCore() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_SaveCore ||
            typeof Window_SaveInfo === 'undefined' ||
            Window_SaveInfo._jtYEP_SaveCorePatched
        ) return;
        const _webSK = StorageManager.webStorageKey;
        StorageManager.webStorageKey = function () {
            return TranslationManager.fetchRawData(() => {
                return _webSK.apply(this, arguments);
            })
        };
        const _makeSI = DataManager.makeSavefileInfo;
        DataManager.makeSavefileInfo = function () {
            const info = _makeSI.apply(this, arguments);
            if (info && $dataSystem) {
                info.title = TranslationManager.getRawData($dataSystem, 'gameTitle');
            }
            return info;
        }
        const _isTGF = DataManager.isThisGameFile;
        DataManager.isThisGameFile = function () {
            return TranslationManager.fetchRawData(() => {
                return _isTGF.apply(this, arguments);
            })
        }
        function _patchTemplate(method, parameter) {
            const ori = Window_SaveInfo.prototype[method];
            Window_SaveInfo.prototype[method] = function () {
                const source = Yanfly.Param[parameter];
                Yanfly.Param[parameter] = TranslationManager.translate(source);
                try {
                    return TranslationManager.skipPluginTrans(() => {
                        return ori.apply(this, arguments);
                    })
                } finally {
                    Yanfly.Param[parameter] = source;
                }
            }
        }
        _patchTemplate('drawPartyLevels', 'SaveInfoActorLvFmt');
        _patchTemplate('drawGoldCount', 'SaveVocabGoldCount');
        Window_SaveInfo.prototype.drawVariable = function (id, dx, dy, dw) {
            const name = TranslationManager.translate($dataSystem.variables[id]).replace(/<<(.*?)>>/i, '');
            const text = Yanfly.Util.toGroup(this._saveContents.variables.value(id));
            const diff = Math.max(0, (this.standardFontSize() - this.contents.fontSize) / 2);
            if (name.length > 0) {
                this._drawData = true;
                try {
                    this.changeTextColor(this.systemColor());
                    TranslationManager.skipPluginTrans(() => {
                        return this.drawTextEx(this.systemColorEx() + name, dx, dy + diff, dw, 'left');
                    })
                } finally {
                    this._drawData = false;
                }
                this.changeTextColor(this.normalColor());
                this.drawText(text, dx, dy, dw, 'right');
            } else {
                this.drawText(text, dx, dy, dw, 'center');
            }
        }
        Window_SaveInfo._jtYEP_SaveCorePatched = true;
    }

    //YEP_X_NewGamePlus.js
    //1.02
    //MV
    //maybe refactor copyboundfields?
    function patch_YEP_X_NewGamePlus() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_X_NewGamePlus ||
            !Imported.YEP_SaveCore ||
            typeof DataManager.prepareNewGamePlusData !== 'function' ||
            typeof DataManager.copyNewGamePlusActorData !== 'function' ||
            typeof DataManager.carryOverNewGamePlusPartyData !== 'function' ||
            DataManager._jtYEP_X_NewGamePlusPatched
        ) return;
        function _restoreFields(source, target, seen) {
            if (!source || !target || typeof source !== 'object' || typeof target !== 'object') return;
            seen = seen || new WeakSet();
            if (seen.has(target)) return;
            seen.add(target);
            TranslationManager.copyBoundFields(source, target);
            Object.keys(source).forEach(function (key) {
                const from = Object.getOwnPropertyDescriptor(source, key);
                const to = Object.getOwnPropertyDescriptor(target, key);
                if (from && to && 'value' in from && 'value' in to) {
                    _restoreFields(from.value, to.value, seen);
                }
            });
        }
        const _prepareNGPD = DataManager.prepareNewGamePlusData;
        DataManager.prepareNewGamePlusData = function () {
            const sources = {
                switches: $gameSwitches._data,
                variables: $gameVariables._data,
                actors: $gameActors._data,
                items: $gameParty._items,
                weapons: $gameParty._weapons,
                armors: $gameParty._armors,
                dataItems: $dataItems,
                dataWeapons: $dataWeapons,
                dataArmors: $dataArmors,
                dmItems: this._independentItems,
                dmWeapons: this._independentWeapons,
                dmArmors: this._independentArmors
            };
            const result = _prepareNGPD.apply(this, arguments);
            const backup = this._ngpData;
            if (backup) {
                Object.keys(sources).forEach(function (key) {
                    _restoreFields(sources[key], backup[key]);
                });
            }
            return result;
        }
        const _copyNGPAD = DataManager.copyNewGamePlusActorData;
        DataManager.copyNewGamePlusActorData = function (actor, id) {
            const result = _copyNGPAD.apply(this, arguments);
            if (result !== actor && this._ngpData) {
                _restoreFields(this._ngpData.actors[id], result);
            }
            return result;
        }
        const _carryONGPPD = DataManager.carryOverNewGamePlusPartyData;
        DataManager.carryOverNewGamePlusPartyData = function () {
            const result = _carryONGPPD.apply(this, arguments);
            const backup = this._ngpData;
            if (backup) {
                _restoreFields(backup.dataItems, $dataItems);
                _restoreFields(backup.dataWeapons, $dataWeapons);
                _restoreFields(backup.dataArmors, $dataArmors);
                _restoreFields(backup.dmItems, this._independentItems);
                _restoreFields(backup.dmWeapons, this._independentWeapons);
                _restoreFields(backup.dmArmors, this._independentArmors);
            }
            return result;
        }
        DataManager._jtYEP_X_NewGamePlusPatched = true;
    }

    //YEP_BaseParamControl.js
    //1.04
    //MV
    //it rlly used name in scripts in example :o
    function patch_YEP_BaseParamControl() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            Imported._jtYEP_BaseParamControlPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (Imported.YEP_BaseParamControl &&
            Imported.YEP_X_ClassBaseParam &&
            typeof Game_Actor.prototype.classBaseParamFormula === 'function'
        ) {
            Game_Actor.prototype.classBaseParamFormula = wrapRaw(Game_Actor.prototype.classBaseParamFormula);
        }
        if (Imported.YEP_EnemyLevels &&
            Imported.YEP_X_EnemyBaseParam &&
            typeof Game_Enemy.prototype.customEnemyBaseParamFormula === 'function'
        ) {
            Game_Enemy.prototype.customEnemyBaseParamFormula = wrapRaw(Game_Enemy.prototype.customEnemyBaseParamFormula);
        }
        Imported._jtYEP_BaseParamControlPatched = true;
    }

    //YEP_SpecialParamFormula.js
    //1.06
    //MV
    function patch_YEP_SpecialParamFormula() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_SpecialParamFormula ||
            Imported._jtYEP_SpecialParamFormulaPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof Game_BattlerBase.prototype.sparam === 'function') {
            Game_BattlerBase.prototype.sparam = wrapRaw(Game_BattlerBase.prototype.sparam);
        }
        if (typeof Game_Actor.prototype.basicFloorDamage === 'function') {
            Game_Actor.prototype.basicFloorDamage = wrapRaw(Game_Actor.prototype.basicFloorDamage);
        }
        if (typeof Game_Actor.prototype.benchMembersExpRate === 'function') {
            Game_Actor.prototype.benchMembersExpRate = wrapRaw(Game_Actor.prototype.benchMembersExpRate);
        }
        if (typeof Game_Action.prototype.applyGuard === 'function') {
            Game_Action.prototype.applyGuard = wrapRaw(Game_Action.prototype.applyGuard);
        }
        Imported._jtYEP_SpecialParamFormulaPatched = true;
    }

    //YEP_ItemCore.js
    //1.30
    //MV
    function patch_YEP_ItemCore() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_ItemCore ||
            Imported._jtYEP_ItemCorePatched
        ) return;
        const installed = new WeakSet();
        function _bindMutableFields(item) {
            if (!item) return;
            ['name', 'description'].forEach(function (key) {
                const field = TranslationManager.bindDataField(item, key);
                if (!field || field.readRaw || installed.has(field)) return;
                const descriptor = Object.getOwnPropertyDescriptor(item, key);
                field.translated = TranslationManager.translate(field.raw);
                Object.defineProperty(item, key, {
                    configurable: descriptor.configurable,
                    enumerable: descriptor.enumerable,
                    get: function () {
                        if (TranslationManager.isJsonExEncoding()) return field.raw;
                        return descriptor.get.call(this);
                    },
                    set: function (value) {
                        if (TranslationManager.isJsonExEncoding()) return;
                        field.raw = value;
                        field.translated = TranslationManager.translate(value);
                    }
                });
                field.getter = Object.getOwnPropertyDescriptor(item, key).get;
                installed.add(field);
            })
        }
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        const _setNII = ItemManager.setNewIndependentItem;
        ItemManager.setNewIndependentItem = function (baseItem, newItem) {
            _bindMutableFields(newItem);
            return TranslationManager.fetchRawData(() => {
                return _setNII.apply(this, arguments);
            })
        };
        const _updateIN = ItemManager.updateItemName;
        ItemManager.updateItemName = function (item) {
            _bindMutableFields(item);
            return TranslationManager.fetchRawData(() => {
                return _updateIN.apply(this, arguments);
            })
        };
        const _loadII = DataManager.loadIndependentItems;
        DataManager.loadIndependentItems = function () {
            const result = _loadII.apply(this, arguments);
            [
                this._independentItems,
                this._independentWeapons,
                this._independentArmors
            ].forEach(function (group) {
                if (group) group.forEach(_bindMutableFields);
            });
            return result;
        };
        if (typeof ItemManager.onCreationEval === 'function') {
            ItemManager.onCreationEval = wrapRaw(ItemManager.onCreationEval);
        };
        if (typeof ItemManager.effectIUSResetStat === 'function') {
            ItemManager.effectIUSResetStat = wrapRaw(ItemManager.effectIUSResetStat);
        };
        if (typeof ItemManager.applyAugmentSetBaseName === 'function') {
            ItemManager.applyAugmentSetBaseName = wrapRaw(ItemManager.applyAugmentSetBaseName);
        };
        if (typeof ItemManager.disassembleEval === 'function') {
            ItemManager.disassembleEval = wrapRaw(ItemManager.disassembleEval);
        };
        if (typeof ItemManager.effectIUSEval === 'function') {
            ItemManager.effectIUSEval = wrapRaw(ItemManager.effectIUSEval);
        };
        if (typeof Window_ItemInfo !== 'undefined') {
            if (typeof Window_ItemInfo.prototype.preInfoEval === 'function') {
                Window_ItemInfo.prototype.preInfoEval = wrapRaw(Window_ItemInfo.prototype.preInfoEval);
            };
            function _installInfoText(method, property) {
                Window_ItemInfo.prototype[method] = function (dy) {
                    const item = this._item;
                    if (item[property] === undefined) {
                        item[property] = DataManager.getBaseItem(item)[property];
                    }
                    const source = item[property];
                    if (source === '') return dy;
                    const lines = TranslationManager.translate(source).split(/[\r\n]+/);
                    return TranslationManager.skipPluginTrans(() => {
                        lines.forEach((line) => {
                            this.resetFontSettings();
                            this.drawTextEx(line, this.textPadding(), dy);
                            dy += this.contents.fontSize + 8;
                        });
                        return dy;
                    })
                }
            }
            _installInfoText('drawInfoTextTop', 'infoTextTop');
            _installInfoText('drawInfoTextBottom', 'infoTextBottom');
        }
        if (typeof Window_ItemActionCommand !== 'undefined') {
            const _addC = Window_ItemActionCommand.prototype.addCommand;
            Window_ItemActionCommand.prototype.addCommand = function (name, symbol, enabled, ext) {
                if (TranslationManager._translationDisableDepth > 0) return _addC.apply(this, arguments);
                return _addC.call(this, TranslationManager.translate(name), symbol, enabled, ext);
            };
            const _drawItem = Window_ItemActionCommand.prototype.drawItem;
            Window_ItemActionCommand.prototype.drawItem = function () {
                return TranslationManager.skipPluginTrans(() => {
                    return _drawItem.apply(this, arguments);
                })
            }
        }
        ['ItemRecoverFmt', 'ItemUseCmd', 'ItemCarryFmt'].forEach(function (key) {
            Yanfly.Param[key] = TranslationManager.translate(Yanfly.Param[key]);
        });
        Imported._jtYEP_ItemCorePatched = true;
    }

    //YEP_X_AttachAugments.js
    //1.11
    //MV
    function patch_YEP_X_AttachAugments() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_ItemCore ||
            !Imported.YEP_X_AttachAugments ||
            typeof Window_ItemActionCommand === 'undefined' ||
            typeof Window_ItemActionCommand.prototype.addAugmentSlots !== 'function' ||
            Imported._jtYEP_X_AttachAugmentsPatched
        ) return;
        const params = PluginManager.parameters('YEP_X_AttachAugments');
        const _processAE = ItemManager.processAugmentEval;
        ItemManager.processAugmentEval = function () {
            return TranslationManager.fetchRawData(() => {
                return _processAE.apply(this, arguments);
            })
        };
        function _slotLabel(item, index) {
            const slots = item.augmentSlots;
            const raw = slots[index];
            const key = DataManager.isWeapon(item) ? 'Weapon Slots' : 'Armor Slots';
            const source = params[key];
            if (typeof source === 'string') {
                const originals = source.split(',').map(s => s.trim());
                const usesDefaults = slots.length === originals.length && slots.every((s, i) => s === originals[i]);
                if (usesDefaults) {
                    const labels = TranslationManager.translate(source).split(/[,，]/).map(s => s.trim());
                    if (labels.length === originals.length && labels.every(s => s.length > 0)) {
                        return labels[index];
                    }
                }
            }
            return TranslationManager.translate(raw);
        }
        function _componentText(item, slot) {
            const component = ItemManager.augmentInSlot(item, slot);
            if (!component) {
                return TranslationManager.translate(Yanfly.Param.AugmentNoneText);
            }
            return '\\i[' + component.iconIndex + ']' + TranslationManager.getTranslatedData(component, 'name');
        }
        const _getASIN = Window_ItemActionCommand.prototype.getAugmentSlotItemName;
        Window_ItemActionCommand.prototype.getAugmentSlotItemName = function (slot) {
            _getASIN.apply(this, arguments);
            return _componentText(this._item, slot);
        };
        Window_ItemActionCommand.prototype.addAugmentSlots = function () {
            const item = this._item;
            ItemManager.checkAugmentSlots(item);
            const format = TranslationManager.translate(Yanfly.Param.AugmentSlotFmt);
            for (let i = 0; i < item.augmentSlots.length; ++i) {
                const text = format.format(_slotLabel(item, i), this.getAugmentSlotItemName(i));
                TranslationManager.pushConvertedText(text);
                this.addCommand(text, 'augment', item.augmentSlotEnable[i], i);
            }
            this.changePaintOpacity(true);
        }
        if (
            typeof Window_ItemInfo !== 'undefined' &&
            typeof Window_ItemInfo.prototype.drawAugmentData === 'function'
        ) {
            Window_ItemInfo.prototype.drawAugmentData = function (slot, dy) {
                const text = _componentText(this._item, slot);
                return TranslationManager.skipPluginTrans(() => {
                    return this.drawTextEx(text, this.textPadding(), dy);
                })
            }
        }
        Imported._jtYEP_X_AttachAugmentsPatched = true;
    }

    //YEP_X_CondShopPrices.js
    //1.01
    //MV
    function patch_YEP_X_CondShopPrices() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_ShopMenuCore ||
            !Imported.YEP_X_CondShopPrices ||
            typeof Yanfly === 'undefined' ||
            !Yanfly.Param ||
            typeof Window_ShopBuy === 'undefined' ||
            typeof Window_ShopBuy.prototype.processConditionalShopPrices !== 'function' ||
            Imported._jtYEP_X_CondShopPricesPatched
        ) return;
        const _CnSPFP = Yanfly.Param.CnShPrFinalizePrice;
        if (typeof _CnSPFP !== 'function') return;
        Yanfly.Param.CnShPrFinalizePrice = function () {
            return TranslationManager.fetchRawData(() => {
                return _CnSPFP.apply(this, arguments);
            })
        };
        Imported._jtYEP_X_CondShopPricesPatched = true;
    }

    //YEP_X_EquipRequirements.js
    //1.09
    //MV
    function patch_YEP_X_EquipRequirements() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_EquipCore ||
            !Imported.YEP_X_EquipRequirements ||
            typeof Window_EquipRequirement === 'undefined' ||
            typeof Game_BattlerBase.prototype.meetEquipEvalRequirements !== 'function' ||
            Imported._jtYEP_X_EquipRequirementsPatched
        ) return;
        const _meetEER = Game_BattlerBase.prototype.meetEquipEvalRequirements;
        Game_BattlerBase.prototype.meetEquipEvalRequirements = function () {
            return TranslationManager.fetchRawData(() => {
                return _meetEER.apply(this, arguments);
            })
        }
        function _wrapTemplateDraw(method) {
            const ori = Window_EquipRequirement.prototype[method];
            Window_EquipRequirement.prototype[method] = function () {
                const least = Yanfly.Param.EqReqAtLeast;
                const most = Yanfly.Param.EqReqAtMost;
                try {
                    Yanfly.Param.EqReqAtLeast = TranslationManager.translate(least);
                    Yanfly.Param.EqReqAtMost = TranslationManager.translate(most);
                    return TranslationManager.withPreparedDisplayText(() => {
                        return ori.apply(this, arguments);
                    })
                } finally {
                    Yanfly.Param.EqReqAtLeast = least;
                    Yanfly.Param.EqReqAtMost = most;
                }
            }
        }
        _wrapTemplateDraw('drawLevelRequirements');
        _wrapTemplateDraw('drawParamRequirements');
        const _drawSR = Window_EquipRequirement.prototype.drawSwitchRequirements;
        Window_EquipRequirement.prototype.drawSwitchRequirements = function () {
            return TranslationManager.withPreparedDisplayText(() => {
                return _drawSR.apply(this, arguments);
            })
        }
        Imported._jtYEP_X_EquipRequirementsPatched = true;
    }

    //YEP_X_HideShowShopItems.js
    //1.00
    //MV
    function patch_YEP_X_HideShowShopItems() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_ShopMenuCore ||
            !Imported.YEP_X_HideShowShopItems ||
            typeof Yanfly === 'undefined' ||
            !Yanfly.Param ||
            typeof Scene_Shop === 'undefined' ||
            typeof Scene_Shop.prototype.isGoodShown !== 'function' ||
            Imported._jtYEP_X_HideShowShopItemsPatched
        ) return;
        const _HSSIFC = Yanfly.Param.HSSIFinalizeCode;
        if (typeof _HSSIFC !== 'function') return;
        Yanfly.Param.HSSIFinalizeCode = function () {
            return TranslationManager.fetchRawData(() => {
                return _HSSIFC.apply(this, arguments);
            })
        }
        Imported._jtYEP_X_HideShowShopItemsPatched = true;
    }

    //YEP_X_ItemDurability.js
    //1.04
    //MV
    function patch_YEP_X_ItemDurability() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_X_ItemDurability ||
            Imported._jtYEP_X_ItemDurabilityPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        Game_Actor.prototype.customDurabilityBreakEval = wrapRaw(Game_Actor.prototype.customDurabilityBreakEval);
        Game_Action.prototype.durabilityEval = wrapRaw(Game_Action.prototype.durabilityEval);
        Scene_Item.prototype.onRepairEval = wrapRaw(Scene_Item.prototype.onRepairEval);
        Window_ItemActionCommand.prototype.addRepairCommand = wrapRaw(Window_ItemActionCommand.prototype.addRepairCommand);
        Imported._jtYEP_X_ItemDurabilityPatched = true;
    }

    //YEP_X_ItemDisassemble.js
    //1.06
    //MV
    function patch_YEP_X_ItemDisassemble() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_ItemCore ||
            !Imported.YEP_X_ItemDisassemble ||
            typeof Window_ItemActionCommand === 'undefined' ||
            typeof Window_DisassemblePool === 'undefined' ||
            Imported._jtYEP_X_ItemDisassemblePatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        Window_ItemActionCommand.prototype.addDisassembleCommand = wrapRaw(Window_ItemActionCommand.prototype.addDisassembleCommand);
        Window_DisassemblePool.prototype.drawDisassembleTypePool = wrapRaw(Window_DisassemblePool.prototype.drawDisassembleTypePool);
        const _drawTE = Window_DisassemblePool.prototype.drawTextEx;
        Window_DisassemblePool.prototype.drawTextEx = function () {
            return TranslationManager.fetchTranslatedData(() => _drawTE.apply(this, arguments));
        };
        Imported._jtYEP_X_ItemDisassemblePatched = true;
    }

    //YEP_X_ItemRequirements.js
    //1.02
    //MV
    function patch_YEP_X_ItemRequirements() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_ItemCore ||
            !Imported.YEP_X_ItemRequirements ||
            typeof ItemManager === 'undefined' ||
            Imported._jtYEP_X_ItemRequirementsPatched
        ) return;
        const methods = [
            'usableItemRequirementEval',
            'usableItemRequirementVariable',
            'checkCustomUsableItemRequirement'
        ]
        methods.forEach(function (name) {
            const ori = ItemManager[name];
            if (typeof ori !== 'function') return;
            ItemManager[name] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            }
        });
        Imported._jtYEP_X_ItemRequirementsPatched = true;
    }

    //YEP_X_EquipSkillTiers.js
    //1.03
    //MV
    function patch_YEP_X_EquipSkillTiers() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_EquipBattleSkills ||
            !Imported.YEP_X_EquipSkillTiers ||
            typeof Yanfly === 'undefined' ||
            !Yanfly.Param ||
            !Yanfly.Param.ESTSort ||
            typeof Window_SkillEquip === 'undefined' ||
            Window_SkillEquip._jtYEP_X_EquipSkillTiersPatched
        ) return;
        const _getS = Window_SkillEquip.prototype.getSkills;
        Window_SkillEquip.prototype.getSkills = function () {
            return TranslationManager.fetchRawData(() => {
                return _getS.apply(this, arguments);
            })
        };
        Window_SkillEquip._jtYEP_X_EquipSkillTiersPatched = true;
    }

    //YEP_KeyboardConfig.js
    //1.04
    //MV
    function patch_YEP_KeyboardConfig() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.YEP_KeyboardConfig ||
            typeof Window_KeyConfig === 'undefined' ||
            Window_KeyConfig._jtYEP_KeyboardConfigPatched
        ) return;
        const _addC = Window_KeyConfig.prototype.addCommand;
        Window_KeyConfig.prototype.addCommand = function (name, symbol, enabled, ext) {
            if (symbol === 'key') {
                return TranslationManager.disablePluginTrans(() => {
                    return _addC.apply(this, arguments);
                })
            }
            return _addC.apply(this, arguments);
        }
        Window_KeyConfig._jtYEP_KeyboardConfigPatched = true;
    }

    //FTKR_AddRoutineMoveCommands.js
    //1.0.1
    //MV
    function patch_FTKR_AddRoutineMoveCommands() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_RMC ||
            Game_Character._jtFTKR_AddRoutineMoveCommandsPatched
        ) return;
        const _processMC = Game_Character.prototype.processMoveCommand;
        const _CEC = Window_Base.prototype.convertEscapeCharacters;
        Window_Base.prototype.convertEscapeCharacters = function (text) {
            const frame = TranslationManager._FTKR_moveScriptFrame;
            if (frame && frame.pending && text === frame.command.parameters[0]) {
                frame.pending = false;
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _CEC.apply(this, arguments);
                    })
                })
            }
            return _CEC.apply(this, arguments);
        }
        Game_Character.prototype.processMoveCommand = function (command) {
            if (!command || command.code !== Game_Character.ROUTE_SCRIPT) {
                return _processMC.apply(this, arguments);
            }
            const cached = Imported.FTKR_CEC && this._originalScriptCommands && this._originalScriptCommands[this._moveRouteIndex];
            const source = cached || command.parameters[0];
            const args = typeof source === 'string' ? /([^:\s]+)[ ]*:[ ]*(.*)/.exec(source) : null;
            const needRaw = args && /^(START_IF|ELSE_IF|START_LOOP)$/.test(args[1].toUpperCase());
            const previous = TranslationManager._FTKR_moveScriptFrame;
            TranslationManager._FTKR_moveScriptFrame = {
                command: command,
                pending: !!Imported.FTKR_CEC
            };
            try {
                return needRaw ? TranslationManager.fetchRawData(() => { return _processMC.call(this, command) }) : _processMC.call(this, command);
            } finally {
                TranslationManager._FTKR_moveScriptFrame = previous;
            }
        }
        Game_Character._jtFTKR_AddRoutineMoveCommandsPatched = true;
    }

    //FTKR_AISkillEvaluate.js
    //1.2.6
    //MV
    function patch_FTKR_AISkillEvaluate() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_ASE ||
            Game_Action._jtFTKR_AISkillEvaluatePatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof Game_Action.prototype.checkAseConditions === 'function') {
            Game_Action.prototype.checkAseConditions = wrapRaw(Game_Action.prototype.checkAseConditions);
        }
        if (typeof Game_Action.prototype.bamEvaluateFormura === 'function') {
            Game_Action.prototype.bamEvaluateFormura = wrapRaw(Game_Action.prototype.bamEvaluateFormura);
        }
        Game_Action._jtFTKR_AISkillEvaluatePatched = true;
    }

    //FTKR_AutoStateConditions.js
    //1.0.1
    //MV
    function patch_FTKR_AutoStateConditions() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_ASC ||
            DataManager._jtFTKR_AutoStateConditionsPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof DataManager.evalAddStateConditions === 'function') {
            DataManager.evalAddStateConditions = wrapRaw(DataManager.evalAddStateConditions);
        }
        if (typeof DataManager.evalRemoveStateConditions === 'function') {
            DataManager.evalRemoveStateConditions = wrapRaw(DataManager.evalRemoveStateConditions);
        }
        DataManager._jtFTKR_AutoStateConditionsPatched = true;
    }

    //FTKR_AutoInvokeSkill.js
    //1.3.2
    //MV
    function patch_FTKR_AutoInvokeSkill() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_AIS ||
            Game_Actor._jtFTKR_AutoInvokeSkillPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof Game_Actor.prototype.checkAutoSkill === 'function') {
            Game_Actor.prototype.checkAutoSkill = wrapRaw(Game_Actor.prototype.checkAutoSkill);
        }
        if (typeof Game_Battler.prototype.checkAutoSkillAll === 'function') {
            Game_Battler.prototype.checkAutoSkillAll = wrapRaw(Game_Battler.prototype.checkAutoSkillAll);
        }
        if (Imported.FTKR_SEP &&
            typeof Game_Actor.prototype.setSepSkill === 'function'
        ) {
            Game_Actor.prototype.setSepSkill = wrapRaw(Game_Actor.prototype.setSepSkill);
        }
        Game_Actor._jtFTKR_AutoInvokeSkillPatched = true;
    }

    //FTKR_BattleAbortConditions.js
    //1.0.0
    //MV
    function patch_FTKR_BattleAbortConditions() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_BAC ||
            typeof FTKR === 'undefined' ||
            typeof FTKR.evalFormula !== 'function' ||
            typeof BattleManager.bacCheckAbort !== 'function' ||
            BattleManager._jtFTKR_BattleAbortConditionsPatched
        ) return;
        BattleManager.bacCheckAbort = function () {
            var c = $gamePlayer._battleAbortCondition;
            if (!this.isBattleEnd() && c) {
                if (TranslationManager.fetchRawData(function () {
                    return FTKR.evalFormula(c.lose);
                })) {
                    this.processDefeat();
                    return true;
                } else if (TranslationManager.fetchRawData(function () {
                    return FTKR.evalFormula(c.win);
                })) {
                    this.processVictory();
                    return true;
                }
            }
            return false;
        };
        BattleManager._jtFTKR_BattleAbortConditionsPatched = true;
    }

    //FTKR_BattleActionPoints.js
    //1.1.0
    //MV
    function patch_FTKR_BattleActionPoints() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_BAP ||
            typeof FTKR === 'undefined' ||
            Game_Action._jtFTKR_BattleActionPointsPatched
        ) return;
        const _turnRAB = Game_Party.prototype.turnRefreshApBase;
        Game_Party.prototype.turnRefreshApBase = function () {
            return TranslationManager.fetchRawData(() => {
                return _turnRAB.apply(this, arguments);
            })
        }
        Game_Action.prototype.applyItemPartyGainAp = function (target) {
            const item = this.item();
            if (!this.subject().isActor() || !item.gainAp) return;
            FTKR.setGameData(this.subject(), target, item);
            const passed = TranslationManager.fetchRawData(() => !item.gainApConditions || FTKR.evalFormula(item.gainApConditions));
            if (passed) {
                $gameParty.gainActionPoint(item.gainAp);
                BattleManager._partyApWindow.refresh();
            }
        }
        function rawDelta(arg) {
            return TranslationManager.fetchRawData(() =>
                TranslationManager.disablePluginTrans(() => {
                    try {
                        let text = arg == null ? '' : arg;
                        const win =
                            SceneManager._scene._windowLayer.children[0];

                        if (win) {
                            text = win.convertEscapeCharacters(text);
                        }
                        return Number(eval(text));
                    } catch (e) {
                        return 0;
                    }
                })
            );
        }
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            const key = command.toUpperCase();
            const isMax =
                key === 'FTKR_最大AP増加' ||
                key === 'FTKR_ADD_MAX_AP';
            const isCurrent =
                key === 'FTKR_現在AP増加' ||
                key === 'FTKR_ADD_CURRENT_AP';
            if (!isMax && !isCurrent) {
                return _pluginC.apply(this, arguments);
            }
            const ap = rawDelta(args[0]);
            if (ap && $gameParty.inBattle()) {
                if (isMax) {
                    $gameParty.growActionPoint(ap);
                } else {
                    $gameParty.gainActionPoint(ap);
                }
                BattleManager._partyApWindow.refresh();
            }
        }
        Game_Action._jtFTKR_BattleActionPointsPatched = true;
    }

    //FTKR_ConvertEscapeCharactersInScript.js
    //1.0.1
    //MV
    function patch_FTKR_ConvertEscapeCharactersInScript() {
        if (Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' || !Imported.FTKR_CEC ||
            Game_Interpreter._jtFTKR_ConvertEscapeCharactersInScriptPatched) return;
        function rawConversion(callback) {
            return TranslationManager.fetchRawData(function () {
                return TranslationManager.disablePluginTrans(callback);
            });
        }
        function withNextRawConversion(callback) {
            var scene = SceneManager._scene;
            var layer = scene && scene._windowLayer;
            var win = layer && layer.children[0];
            if (!win) return callback();
            var own = Object.getOwnPropertyDescriptor(
                win, 'convertEscapeCharacters'
            );
            var original = win.convertEscapeCharacters;
            function restore() {
                if (win.convertEscapeCharacters !== once) return;
                if (own) {
                    Object.defineProperty(win, 'convertEscapeCharacters', own);
                } else {
                    delete win.convertEscapeCharacters;
                }
            }
            function once() {
                var receiver = this;
                var args = arguments;
                restore();
                return rawConversion(function () {
                    return original.apply(receiver, args);
                });
            }
            Object.defineProperty(win, 'convertEscapeCharacters', {
                configurable: true,
                writable: true,
                enumerable: own ? own.enumerable : false,
                value: once
            });
            try {
                return callback();
            } finally {
                restore();
            }
        }
        var _setSC = Game_Interpreter.prototype.setScriptCodes;
        Game_Interpreter.prototype.setScriptCodes = function () {
            var self = this, args = arguments;
            return rawConversion(function () {
                return _setSC.apply(self, args);
            });
        };
        function wrapNext(proto, name, condition) {
            var original = proto[name];
            proto[name] = function () {
                if (!condition.apply(this, arguments)) {
                    return original.apply(this, arguments);
                }
                var self = this, args = arguments;
                return withNextRawConversion(function () {
                    return original.apply(self, args);
                });
            };
        }
        wrapNext(Game_Interpreter.prototype, 'command111', function () {
            return this._params[0] == 12;
        });
        wrapNext(Game_Interpreter.prototype, 'command122', function () {
            return this._params[0] == 4;
        });
        wrapNext(Game_Character.prototype, 'processMoveCommand', function (command) {
            return command.code == Game_Character.ROUTE_SCRIPT;
        });
        Game_Interpreter._jtFTKR_ConvertEscapeCharactersInScriptPatched = true;
    }

    //FTKR_CustomSimpleActorStatus.js
    //3.5.3
    //MV
    function patch_FTKR_CustomSimpleActorStatus() {
        if (Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' || !Imported.FTKR_CSS ||
            typeof FTKR === 'undefined' || !FTKR.CSS ||
            !FTKR.CSS.cssStatus || Window_Base._jtFTKR_CustomSimpleActorStatusPatched ||
            typeof Window_Base.prototype.drawCssActorStatus !== 'function'
        ) return;
        function wrap(target, name, handler) {
            const ori = target && target[name];
            if (typeof ori !== 'function') return;
            target[name] = function () {
                return handler.call(this, ori, arguments);
            }
        }
        [
            'cssChangeCustomImage',
            'cssChangeWindowSetting',
            'cssChangeWindowSettingParam'
        ].forEach(function (name) {
            wrap(Game_Interpreter.prototype, name, function (original, args) {
                return TranslationManager.fetchRawData(() =>
                    TranslationManager.disablePluginTrans(() => original.apply(this, args))
                );
            });
        });
        wrap(Window_Base.prototype, 'convertTextWidth', function (original, args) {
            const text = TranslationManager.translate(args[0]);
            return TranslationManager.skipPluginTrans(() => original.call(this, text));
        });
        Window_Base.prototype.drawCssProfile = function (actor, x, y, width) {
            this._setItem = actor.actor();
            const text = TranslationManager.translate(actor.profile());
            const lines = text.split('\n');
            const dy = this.lineHeight();
            lines.forEach(function (line, i) {
                TranslationManager.skipPluginTrans(() =>
                    this.drawTextEx(line, x, y + dy * i)
                )
            }, this);
            return lines.length;
        }
        function _translateField(object, key) {
            if (object && typeof object[key] === 'string') {
                object[key] = TranslationManager.translate(object[key]);
            }
        }
        const _css = FTKR.CSS.cssStatus;
        _translateField(_css.message, 'levelUp');
        [
            'pdiff', 'ediff', 'aopdiff', 'ediffaop'
        ].forEach(function (key) {
            _translateField(_css[key], 'plus');
            _translateField(_css[key], 'minus');
        });
        if (FTKR.CBR && FTKR.CBR.message) {
            _translateField(FTKR.CBR.message, 'levelUp');
            _translateField(FTKR.CBR.message, 'newSkill');
        }
        [
            'drawCssActorMessage',
            'drawCssActorMessageCBR',
            'drawParamDiffValue'
        ].forEach(function (name) {
            wrap(Window_Base.prototype, name, function (original, args) {
                return TranslationManager.skipPluginTrans(() => original.apply(this, args));
            });
        });
        let cssDrawDepth = 0;
        wrap(Window_Base.prototype, 'drawCssActorStatus', function (original, args) {
            cssDrawDepth++;
            try {
                return original.apply(this, args);
            } finally {
                cssDrawDepth--;
            }
        });
        ['evalFormula', 'evalStrFormula'].forEach(function (name) {
            wrap(FTKR, name, function (original, args) {
                return cssDrawDepth > 0
                    ? TranslationManager.fetchRawData(() => original.apply(this, args))
                    : original.apply(this, args);
            });
        });
        Window_Base._jtFTKR_CustomSimpleActorStatusPatched = true;
    }

    //FTKR_CSS_CustomizeBattleResults.js
    //2.1.4
    //MV
    function patch_FTKR_CSS_CustomizeBattleResults() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_CSS || !Imported.FTKR_CBR ||
            typeof FTKR === 'undefined' ||
            !FTKR.CBR || !FTKR.CBR.actor ||
            typeof Window_BattleResultActor === 'undefined' ||
            Window_BattleResultActor.FTKR_CSS_CustomizeBattleResultsPatched ||
            typeof Window_BattleResultActor.prototype.displayMembers !== 'function'
        ) return;
        const _displayM = Window_BattleResultActor.prototype.displayMembers;
        Window_BattleResultActor.prototype.displayMembers = function () {
            const _type = FTKR.CBR.actor.memberType;
            if (typeof _type === 'string') {
                return TranslationManager.fetchRawData(() => {
                    return _displayM.apply(this, arguments);
                })
            }
            return _displayM.apply(this, arguments);
        }
        Window_BattleResultActor.FTKR_CSS_CustomizeBattleResultsPatched = true;
    }

    //FTKR_CSS_BattleStatus.js
    //2.2.0
    //MV
    //also FTKR_CSS_DetailedStatus.js
    //2.1.4
    //also FTKR_CSS_MenuStatus.js
    //2.1.3
    //also FTKR_CSS_SkillStatus.js
    //2.1.3
    //also FTKR_CSS_ShopStatus.js
    //2.3.0
    function patch_FTKR_CSS_BattleStatus() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_CSS ||
            (!Imported.FTKR_CSS_BS && !Imported.FTKR_CSS_DS && !Imported.FTKR_CSS_MS && !Imported.FTKR_CSS_SS && !Imported.FTKR_CSS_SpS) ||
            Window_Base._jtFTKR_CSS_BattleStatusPatched ||
            typeof Window_Base.prototype.drawCssActorStatus !== 'function'
        ) return;
        const _drawCAS = Window_Base.prototype.drawCssActorStatus;
        const active = new WeakSet();
        Window_Base.prototype.drawCssActorStatus = function () {
            if (active.has(this)) {
                return _drawCAS.apply(this, arguments);
            }
            const own = Object.getOwnPropertyDescriptor(this, 'drawTextEx');
            const draw = this.drawTextEx;
            if (typeof draw !== 'function' || (own && !own.configurable)) {
                return _drawCAS.apply(this, arguments);
            }
            function _prepareDrawTextEx() {
                const args = Array.prototype.slice.call(arguments);
                if (
                    TranslationManager._translatedSkipDepth > 0) {
                    return draw.apply(this, args);
                }
                args[0] = TranslationManager.translate(args[0]);
                return TranslationManager.skipPluginTrans(() => {
                    return draw.apply(this, args);
                })
            }
            Object.defineProperty(this, 'drawTextEx', {
                configurable: true,
                enumerable: own ? own.enumerable : false,
                writable: true,
                value: _prepareDrawTextEx
            });
            active.add(this);
            try {
                return _drawCAS.apply(this, arguments);
            } finally {
                active.delete(this);
                if (own) {
                    Object.defineProperty(this, 'drawTextEx', own);
                } else {
                    delete this.drawTextEx;
                }
            }
        }
        Window_Base._jtFTKR_CSS_BattleStatusPatched = true;
    }

    //FTKR_DamageFixedStates.js
    //1.0.0
    //MV
    function patch_FTKR_DamageFixedStates() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_DFS ||
            Game_BattlerBase._jtFTKR_DamageFixedStatesPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof Game_BattlerBase.prototype.isDfsStateAffected === 'function') {
            Game_BattlerBase.prototype.isDfsStateAffected = wrapRaw(Game_BattlerBase.prototype.isDfsStateAffected);
        }
        if (typeof Game_Actor.prototype.setSepSkill === 'function') {
            Game_Actor.prototype.setSepSkill = wrapRaw(Game_Actor.prototype.setSepSkill);
        }
        Game_BattlerBase._jtFTKR_DamageFixedStatesPatched = true;
    }

    //FTKR_ExBattleCommand.js
    //2.2.2
    //MV
    function patch_FTKR_ExBattleCommand() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_EBC ||
            Window_Command._jtFTKR_ExBattleCommandPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof Window_Command.prototype.isEbcCommandEnabled === 'function') {
            Window_Command.prototype.isEbcCommandEnabled = wrapRaw(Window_Command.prototype.isEbcCommandEnabled);
        }
        if (typeof Window_Command.prototype.isEbcCurrentItemEnabled === 'function') {
            Window_Command.prototype.isEbcCurrentItemEnabled = wrapRaw(Window_Command.prototype.isEbcCurrentItemEnabled);
        }
        if (typeof Window_PartyCommand.prototype.includeEbc === 'function') {
            Window_PartyCommand.prototype.includeEbc = wrapRaw(Window_PartyCommand.prototype.includeEbc);
        }
        const _updateESH = Window_Command.prototype.updateEbcSkillHelp;
        if (typeof _updateESH === 'function') {
            Window_Command.prototype.updateEbcSkillHelp = function () {
                const item = this.currentEbcSkill();
                const desc = item && item.description;
                if (typeof desc === 'string' && desc) {
                    TranslationManager._pushRecent(TranslationManager.translate(desc));
                }
                return _updateESH.apply(this, arguments);
            }
        }
        Window_Command._jtFTKR_ExBattleCommandPatched = true;
    }

    //FTKR_ExBattleEvent.js
    //1.3.6
    //MV
    function patch_FTKR_ExBattleEvent() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_EBE ||
            Game_Troop._jtFTKR_ExBattleEventPatched ||
            typeof Game_Troop.prototype.evalConditionsFormula !== 'function'
        ) return;
        const _evalCF = Game_Troop.prototype.evalConditionsFormula;
        Game_Troop.prototype.evalConditionsFormula = function () {
            return TranslationManager.fetchRawData(() => {
                return _evalCF.apply(this, arguments);
            })
        }
        Game_Troop._jtFTKR_ExBattleEventPatched = true;
    }

    //FTKR_ExGuardEffect.js
    //1.0.2
    //MV
    function patch_FTKR_ExGuardEffect() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_EGF ||
            typeof Game_BattlerBase.prototype.traitsSumAllEval !== 'function' ||
            Game_BattlerBase.FTKR_ExGuardEffectPatched
        ) return;
        const _traitsSAE = Game_BattlerBase.prototype.traitsSumAllEval;
        Game_BattlerBase.prototype.traitsSumAllEval = function () {
            return TranslationManager.fetchRawData(() => {
                return _traitsSAE.apply(this, arguments);
            })
        }
        Game_BattlerBase.FTKR_ExGuardEffectPatched = true;
    }

    //FTKR_ExItemBox.js
    //1.0.0
    //MV
    //also FTKR_ItemBoxCategory.js
    //1.1.0
    //MV
    function patch_FTKR_ExItemBox() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' || (!Imported.FTKR_EIB && !Imported.FTKR_IBCt) ||
            typeof FTKR === 'undefined' || (!FTKR.EIB && !FTKR.IBCt) ||
            TextManager._jtFTKR_ExItemBoxPatched
        ) return;
        const _convertIC = TextManager.convertItemCategory;
        TextManager.convertItemCategory = function () {
            return TranslationManager.fetchRawData(() => {
                return _convertIC.apply(this, arguments);
            })
        }
        TextManager._jtFTKR_ExItemBoxPatched = true;
    }

    //FTKR_ExItemConfig_Damage.js
    //1.1.2
    //MV
    function patch_FTKR_ExItemConfig_Damage() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_EID ||
            Game_Action._jtFTKR_ExItemConfig_DamagePatched
        ) return;
        const names = [
            'evalDamagesEnabled',
            'evalDamageFormula',
            'itemDamageRate',
            'itemDamageCriticalRate'
        ];
        names.forEach(function (name) {
            if (typeof Game_Action.prototype[name] !== 'function') return;
            const ori = Game_Action.prototype[name];
            Game_Action.prototype[name] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            }
        })
        Game_Action._jtFTKR_ExItemConfig_DamagePatched = true;
    }

    //FTKR_ExItemConfig_Effect.js
    //1.2.1
    //MV
    function patch_FTKR_ExItemConfig_Effect() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_EIE ||
            Game_Action._jtFTKR_ExItemConfig_EffectPatched
        ) return;
        [
            'evalEffectEnabled',
            'setSepEffectValue1',
            'setSepEffectValue2'
        ].forEach(function (name) {
            const original = Game_Action.prototype[name];
            if (typeof original !== 'function') return;
            Game_Action.prototype[name] = function () {
                return TranslationManager.fetchRawData(function () {
                    return original.apply(this, arguments);
                });
            };
        });
        Game_Action._jtFTKR_ExItemConfig_EffectPatched = true;
    }

    //FTKR_ExItemConfig_ItemBasic.js
    //1.1.2
    //MV
    //also FTKR_ExItemConfig_IB_SkillCost.js
    function patch_FTKR_ExItemConfig_ItemBasic() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' || !Imported.FTKR_IEP ||
            DataManager._jtFTKR_ExItemConfig_ItemBasicPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof DataManager.evalEnabledFormula === 'function') {
            DataManager.evalEnabledFormula = wrapRaw(DataManager.evalEnabledFormula);
        }
        if (Imported.FTKR_IEP_SC && typeof Game_BattlerBase.prototype.skillIepCost === 'function') {
            Game_BattlerBase.prototype.skillIepCost = wrapRaw(Game_BattlerBase.prototype.skillIepCost);
        }
        DataManager._jtFTKR_ExItemConfig_ItemBasicPatched = true;
    }

    //FTKR_ExItemConfig_Required.js
    //1.0.3
    //MV
    function patch_FTKR_ExItemConfig_Required() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_EIR ||
            typeof Game_Actor.prototype.evalEirFormula !== 'function' ||
            Game_Actor._jtFTKR_ExItemConfig_RequiredPatched
        ) return;
        const _evalEF = Game_Actor.prototype.evalEirFormula;
        Game_Actor.prototype.evalEirFormula = function () {
            return TranslationManager.fetchRawData(() => {
                return _evalEF.apply(this, arguments);
            })
        }
        Game_Actor._jtFTKR_ExItemConfig_RequiredPatched = true;
    }

    //FTKR_ExSvMotion.js
    //1.4.0
    //MV
    function patch_FTKR_ExSvMotion() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_ESM ||
            typeof Game_BattlerBase.prototype.evalEsmCondition !== 'function' ||
            Game_BattlerBase._jtFTKR_ExSvMotionPatched
        ) return;
        const _evalEC = Game_BattlerBase.prototype.evalEsmCondition;
        Game_BattlerBase.prototype.evalEsmCondition = function () {
            return TranslationManager.fetchRawData(() => {
                return _evalEC.apply(this, arguments);
            })
        }
        Game_BattlerBase._jtFTKR_ExSvMotionPatched = true;
    }

    //FTKR_ExVariablesChange.js
    //1.2.4
    //MV
    function patch_FTKR_ExVariablesChange() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_EVC ||
            typeof FTKR === 'undefined' ||
            typeof FTKR.evalCalcFormula !== 'function' ||
            FTKR._jtFTKR_ExVariablesChangePatched
        ) return;
        const _evalCF = FTKR.evalCalcFormula;
        FTKR.evalCalcFormula = function () {
            return TranslationManager.fetchRawData(() => {
                return _evalCF.apply(this, arguments);
            })
        }
        FTKR._jtFTKR_ExVariablesChangePatched = true;
    }

    //FTKR_ExTraitSetting.js
    //1.0.4
    //MV
    function patch_FTKR_ExTraitSetting() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_ETS ||
            Game_BattlerBase._jtFTKR_ExTraitSettingPatched
        ) return;
        [
            'traitsWithIdOperator',
            'traitsEtsMultiDiv',
            'traitsEtsMulti',
            'traitsEtsDiv',
            'traitsEtsMultiDivAll',
            'traitsEtsMultiAll',
            'traitsEtsDivAll',
            'traitsEtsSum',
            'traitsEtsSumAll'
        ].forEach(function (name) {
            if (typeof Game_BattlerBase.prototype[name] !== 'function') return;
            const ori = Game_BattlerBase.prototype[name];
            Game_BattlerBase.prototype[name] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            }
        });
        Game_BattlerBase._jtFTKR_ExTraitSettingPatched = true;
    }

    //FTKR_ItemCompositionSystem.js
    //1.7.4
    //MV
    function patch_FTKR_ItemCompositionSystem() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_ICS ||
            DataManager._jtFTKR_ItemCompositionSystemPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        const disablePluginTrans = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return fn.apply(this, arguments);
                    })
                })
            }
        }
        DataManager.searchItemName = wrapRaw(DataManager.searchItemName);
        DataManager.convertCategoryItem = wrapRaw(DataManager.convertCategoryItem);
        Game_Interpreter.prototype.addRecipe = disablePluginTrans(Game_Interpreter.prototype.addRecipe);
        Game_Interpreter.prototype.reduceRecipe = disablePluginTrans(Game_Interpreter.prototype.reduceRecipe);
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (/^ICS_(?:OPEN|合成画面表示)$/i.test(command)) {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _pluginC.apply(this, arguments);
                    })
                })
            }
            return _pluginC.apply(this, arguments);
        }
        const _installed = new WeakSet();
        function _installIcsScene(proto) {
            const _setIT = proto.setItemTraits;
            proto.setItemTraits = function (...args) {
                const target = args[0];
                const source = this._compositionStateWindow._comp.slots[0].item();
                TranslationManager.copyBoundFields(source, target);
                const baseKey = source.compositCount ? 'baseName' : 'name';
                const rawBase = TranslationManager.getRawData(source, baseKey);
                const translatedBase = TranslationManager.translate(TranslationManager.getTranslatedData(source, baseKey));
                const suffix = '(+' + target.compositCount + ')';
                TranslationManager.setDataField(target, 'baseName', rawBase, translatedBase);
                TranslationManager.setDataField(target, 'name', rawBase + suffix, translatedBase + suffix);
                return _setIT.apply(this, args);
            }
        }
        const _goto = SceneManager.goto;
        SceneManager.goto = function (...args) {
            const SceneClass = args[0];
            const proto = SceneClass && SceneClass.prototype;
            if (proto &&
                typeof proto.createCompositionStateWindow === 'function' &&
                typeof proto.createCompositionSlotWindow === 'function' &&
                typeof proto.isSpecialComp === 'function' &&
                typeof proto.setItemTraits === 'function' &&
                !_installed.has(proto)) {
                _installIcsScene(proto);
                _installed.add(proto);
            }
            return _goto.apply(this, args);
        }
        const _saveKeys = [
            'icsItemDatas',
            'icsWeaponDatas',
            'icsArmorDatas'
        ];
        const _makeSC = DataManager.makeSaveContents;
        DataManager.makeSaveContents = function (...args) {
            const contents = _makeSC.apply(this, args);
            _saveKeys.forEach(function (key) {
                if (contents[key]) {
                    contents[key] = TranslationManager.fetchRawData(() => {
                        return JsonEx.makeDeepCopy(contents[key]);
                    })
                }
            });
            return contents;
        }
        function _bindLoadedItem(item) {
            if (!item) return;
            const rawName = TranslationManager.getRawData(item, 'name');
            [
                'name',
                'description',
                'preName',
                'preDescription',
                'baseName'
            ].forEach(function (key) {
                if (typeof TranslationManager.getRawData(item, key) === 'string') {
                    TranslationManager.translateDataField(item, key);
                }
            });
            if (item.compositCount && typeof TranslationManager.getRawData(item, 'baseName') === 'string') {
                const translatedName = TranslationManager.getTranslatedData(item, 'baseName') + '(+' + item.compositCount + ')';
                TranslationManager.setDataField(
                    item, 'name', rawName, translatedName
                );
            }
        }
        const _extractSC = DataManager.extractSaveContents;
        DataManager.extractSaveContents = function (...args) {
            const result = _extractSC.apply(this, args);
            const contents = args[0];
            _saveKeys.forEach(function (key) {
                if (contents[key]) {
                    contents[key].forEach(_bindLoadedItem);
                }
            })
            return result;
        }
        DataManager._jtFTKR_ItemCompositionSystemPatched = true;
    }

    //FTKR_ItemSelfVariables.js
    //1.2.2
    //MV
    function patch_FTKR_ItemSelfVariables() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' || !Imported.FTKR_ISV ||
            typeof Game_IsvSelfVariables === 'undefined' ||
            Game_IsvSelfVariables._jtFTKR_ItemSelfVariablesPatched
        ) return;
        ['evalFormula', 'evalCalcFormula'].forEach(function (name) {
            const ori = FTKR[name];
            if (typeof ori !== 'function') return;

            FTKR[name] = function () {
                return TranslationManager.fetchRawData(() =>
                    ori.apply(this, arguments)
                );
            };
        });
        Game_IsvSelfVariables._jtFTKR_ItemSelfVariablesPatched = true;
    }

    //FTKR_ItemSubCommand.js
    //1.7.3
    //MV
    function patch_FTKR_ItemSubCommand() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' || !Imported.FTKR_ISC ||
            typeof FTKR === 'undefined' || !FTKR.ISC ||
            typeof Window_ItemSubCommand === 'undefined' ||
            Window_ItemSubCommand._jtFTKR_ItemSubCommandPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        ['isCustomShow', 'isCustomEnabled'].forEach(function (name) {
            if (typeof Window_ItemSubCommand.prototype[name] !== 'function') return;
            Window_ItemSubCommand.prototype[name] = wrapRaw(Window_ItemSubCommand.prototype[name]);
        });
        Window_ItemSubCommand._jtFTKR_ItemSubCommandPatched = true;
    }

    //FTKR_PopupSpriteMessage.js
    //1.2.5
    //MV
    function patch_FTKR_PopupSpriteMessage() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_PSM ||
            Game_Interpreter._jtFTKR_PopupSpriteMessagePatched ||
            typeof Game_Interpreter.prototype.setupRotateMessage !== 'function' ||
            typeof Spriteset_Base.prototype.createPopupMessages !== 'function'
        ) return;
        const _setRM = Game_Interpreter.prototype.setupRotateMessage;
        Game_Interpreter.prototype.setupRotateMessage = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _setRM.apply(this, arguments);
                })
            })
        }
        const patchedPrototypes = new WeakSet();
        function patchSprite(sprite) {
            if (!sprite) return;
            const proto = Object.getPrototypeOf(sprite);
            if (
                !proto || patchedPrototypes.has(proto) ||
                typeof proto.getTextWidth !== 'function' ||
                typeof proto.setupSprite !== 'function'
            ) return;
            ['getTextWidth', 'setupSprite'].forEach(function (name) {
                const ori = proto[name];
                proto[name] = function () {
                    return TranslationManager.skipPluginTrans(() => {
                        return ori.apply(this, arguments);
                    })
                }
            });
            patchedPrototypes.add(proto);
        }
        const _createPM = Spriteset_Base.prototype.createPopupMessages;
        Spriteset_Base.prototype.createPopupMessages = function () {
            const result = _createPM.apply(this, arguments);
            if (Array.isArray(this._ftPopupMessages)) {
                this._ftPopupMessages.forEach(patchSprite);
            }
            return result;
        }
        if (
            Imported.FTKR_ISV &&
            typeof Game_IsvSelfVariables !== 'undefined' &&
            typeof Game_IsvSelfVariables.prototype.value === 'function'
        ) {
            let _displayConversionDepth = 0;
            const _setPM = Game_Party.prototype.setPopupMessage;
            Game_Party.prototype.setPopupMessage = function () {
                _displayConversionDepth++;
                try {
                    return _setPM.apply(this, arguments);
                } finally {
                    _displayConversionDepth--;
                }
            };
            const _selfVariableValue = Game_IsvSelfVariables.prototype.value;
            Game_IsvSelfVariables.prototype.value = function () {
                const value = _selfVariableValue.apply(this, arguments);
                if (_displayConversionDepth > 0 && typeof value === 'string') {
                    return TranslationManager.translate(value);
                }
                return value;
            }
        }
        Game_Interpreter._jtFTKR_PopupSpriteMessagePatched = true;
    }

    //FTKR_OriginalSceneWindow.js
    //1.7.1
    //MV
    function patch_FTKR_OriginalSceneWindow() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_OSW ||
            typeof Game_OswBase === 'undefined' ||
            typeof Game_OswCommand === 'undefined' ||
            typeof Game_OswCommon === 'undefined' ||
            typeof Game_OswSelectable === 'undefined' ||
            Game_Interpreter._jtFTKR_OriginalSceneWindowPatched
        ) return;
        function rawLogic(callback) {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(callback);
            })
        }
        function wrapper(target, name, disableTransSwitch) {
            const ori = target[name];
            if (typeof ori !== 'function') return;
            target[name] = function () {
                const invoke = () => ori.apply(this, arguments);
                return disableTransSwitch ? rawLogic(invoke) : TranslationManager.fetchRawData(invoke);
            }
        }
        [
            'gameData',
            'setOswWindowParam',
            'createOswList',
            'setOswWindowArgs',
            'setOswCommandArgs',
            'setOswCommandCancel',
            'setOswMethod',
            'setOswContentArgs',
            'setOswStatusListContentArgs',
            'setOswSelectArgs',
            'setOswSelectList'
        ].forEach(function (name) {
            wrapper(Game_Interpreter.prototype, name, true);
        });
        const _commandPrototypes = new WeakSet();
        const _commonPrototypes = new WeakSet();
        const _selectPrototypes = new WeakSet();
        function _installCommand(proto) {
            if (_commandPrototypes.has(proto)) return;
            proto.makeCommandList = function () {
                this._window._list.forEach(function (cmd) {
                    var enabled = rawLogic(() => eval(this.convertEscapeCharacters(cmd.enabled)));
                    this.addCommand(cmd.name, cmd.symbol, enabled);
                }, this);
            }
            wrapper(proto, 'setMethodHandler', false);
            _commandPrototypes.add(proto);
        }
        function _installCommon(proto) {
            if (_commonPrototypes.has(proto)) return;
            wrapper(proto, 'evalCssCustomFormula', false);
            wrapper(proto, 'evalCssStrFormula', false);
            _commonPrototypes.add(proto);
        }
        function _installSelect(proto) {
            if (_selectPrototypes.has(proto)) return;
            wrapper(proto, 'makeItemList', false);
            wrapper(proto, 'isEnabled', false);
            wrapper(proto, 'setMethodHandler', false);
            wrapper(proto, 'evalCssCustomFormula', false);
            wrapper(proto, 'evalCssStrFormula', false);
            _selectPrototypes.add(proto);
        }
        function _observeCreation(name, baseProto, configurationClass, install) {
            const _create = Scene_Base.prototype[name];
            if (typeof _create !== 'function') return;
            Scene_Base.prototype[name] = function () {
                const own = Object.getOwnPropertyDescriptor(baseProto, 'initialize');
                const _initialize = baseProto.initialize;
                function observedInitialize() {
                    if (this._window instanceof configurationClass) {
                        install(Object.getPrototypeOf(this));
                    }
                    return _initialize.apply(this, arguments);
                }
                Object.defineProperty(baseProto, 'initialize', {
                    configurable: true,
                    writable: true,
                    enumerable: own ? own.enumerable : false,
                    value: observedInitialize
                });
                try { return _create.apply(this, arguments) } finally {
                    if (own) {
                        Object.defineProperty(baseProto, 'initialize', own);
                    } else {
                        delete baseProto.initialize;
                    }
                }
            }
        }
        _observeCreation(
            'createCommandWindow',
            Window_Command.prototype,
            Game_OswCommand,
            _installCommand
        );
        _observeCreation(
            'createCommonWindow',
            Window_Base.prototype,
            Game_OswCommon,
            _installCommon
        );
        _observeCreation(
            'createSelectWindow',
            Window_Selectable.prototype,
            Game_OswSelectable,
            _installSelect
        );
        Game_Interpreter._jtFTKR_OriginalSceneWindowPatched = true;
    }

    //FTKR_SetupTroops.js
    //1.1.0
    //MV
    function patch_FTKR_SetupTroops() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_STP ||
            typeof Game_Interpreter.prototype.setArgNumber !== 'function' ||
            Game_Interpreter._jtFTKR_SetupTroopsPatched
        ) return;
        const _setAN = Game_Interpreter.prototype.setArgNumber;
        Game_Interpreter.prototype.setArgNumber = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _setAN.apply(this, arguments);
                })
            })
        }
        Game_Interpreter._jtFTKR_SetupTroopsPatched = true;
    }

    //FTKR_SEP_ShowSkillStatus.js
    //1.4.7
    //MV
    function patch_FTKR_SEP_ShowSkillStatus() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_SEP ||
            !Imported.FTKR_SSS ||
            typeof FTKR === 'undefined' ||
            !FTKR.SSS ||
            !FTKR.SSS.parameters ||
            typeof Window_Base.prototype.drawFormatText !== 'function' ||
            typeof Window_Base.prototype.drawDescription !== 'function' ||
            typeof Window_Base.prototype.getDesc !== 'function' ||
            Window_Base._jtFTKR_SEP_ShowSkillStatusPatched
        ) return;
        const _drawFT = Window_Base.prototype.drawFormatText;
        Window_Base.prototype.drawFormatText = function (format, x, y, params, width, height) {
            if (TranslationManager._translatedSkipDepth > 0) {
                return _drawFT.apply(this, arguments);
            }
            const formatTranslated = TranslationManager.translate(format);
            const paramsTranslated = Array.isArray(params) ? params.map(function (value) {
                return typeof value === 'string' ? TranslationManager.translate(value) : value;
            }) : params;
            return TranslationManager.skipPluginTrans(() => {
                return _drawFT.call(
                    this,
                    formatTranslated, x, y, paramsTranslated, width, height
                )
            })
        };
        Window_Base.prototype.drawDescription = function (x, y, width, skill) {
            const diff = this.diffPadding();
            const desc = TranslationManager.translate(this.getDesc(skill));
            const lines = desc.split('\n');
            const lineHeight = this.lineHeight();
            return TranslationManager.skipPluginTrans(() => {
                lines.forEach((line, index) => {
                    this.drawFormatText(line, x + diff, y + diff + lineHeight * index, [], width * 0.95);
                })
            })
        };
        Window_Base._jtFTKR_SEP_ShowSkillStatusPatched = true;
    }

    //FTKR_ShowPictureBalloon.js
    //1.0.0
    //MV
    function patch_FTKR_ShowPictureBalloon() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_SPB ||
            typeof Game_Interpreter.prototype.setupPictureBalloon !== 'function' ||
            Game_Interpreter._jtFTKR_ShowPictureBalloonPatched
        ) return;
        const _setupPB = Game_Interpreter.prototype.setupPictureBalloon;
        Game_Interpreter.prototype.setupPictureBalloon = function () {
            return TranslationManager.disablePluginTrans(() => {
                return _setupPB.apply(this, arguments);
            })
        }
        Game_Interpreter._jtFTKR_ShowPictureBalloonPatched = true;
    }

    //FTKR_SkillCounter.js
    //1.0.6
    //MV
    function patch_FTKR_SkillCounter() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_SCT ||
            typeof DataManager.evalSctFormula !== 'function' ||
            DataManager._jtFTKR_SkillCounterPatched
        ) return;
        const _evalSF = DataManager.evalSctFormula;
        DataManager.evalSctFormula = function () {
            return TranslationManager.fetchRawData(() => {
                return _evalSF.apply(this, arguments);
            })
        }
        DataManager._jtFTKR_SkillCounterPatched = true;
    }

    //FTKR_SkillSubCommand.js
    //1.0.0
    //MV
    function patch_FTKR_SkillSubCommand() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.FTKR_SSC ||
            typeof Game_Actor.prototype.evalSscFormula !== 'function' ||
            Game_Actor._jtFTKR_SkillSubCommandPatched
        ) return;
        const _evalSF = Game_Actor.prototype.evalSscFormula;
        Game_Actor.prototype.evalSscFormula = function () {
            return TranslationManager.fetchRawData(() => {
                return _evalSF.apply(this, arguments);
            })
        }
        Game_Actor._jtFTKR_SkillSubCommandPatched = true;
    }

    //DarkPlasma_ConcurrentParty.js
    //1.3.0
    //MV
    function patch_DarkPlasma_ConcurrentParty() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_Party.prototype.createDevidedParty !== 'function' ||
            typeof Game_Party.prototype.devidedParties !== 'function' ||
            Game_Interpreter._jtDarkPlasma_ConcurrentPartyPatched
        ) return;
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (command === 'createParty') {
                return TranslationManager.fetchRawData(() => {
                    return _pluginC.apply(this, arguments);
                })
            }
            return _pluginC.apply(this, arguments);
        }
        Game_Interpreter._jtDarkPlasma_ConcurrentPartyPatched = true;
    }

    //DarkPlasma_LicenseManager.js
    //3.0.0
    //MV
    function patch_DarkPlasma_LicenseManager() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Scene_License === 'undefined' ||
            typeof Scene_License.prototype.createLicenseWindows !== 'function' ||
            Scene_License._jtDarkPlasma_LicenseManagerPatched
        ) return;
        const _patchedWindow = new WeakSet();
        const _createLW = Scene_License.prototype.createLicenseWindows;
        Scene_License.prototype.createLicenseWindows = function () {
            const _initialize = Window_Command.prototype.initialize;
            Window_Command.prototype.initialize = function () {
                if (!_patchedWindow.has(this)) {
                    const _addC = this.addCommand;
                    this.addCommand = function (name, symbol) {
                        if (symbol === 'author') {
                            return TranslationManager.disablePluginTrans(() => {
                                return _addC.apply(this, arguments);
                            })
                        }
                        return _addC.apply(this, arguments);
                    }
                    _patchedWindow.add(this);
                }
                return _initialize.apply(this, arguments);
            };
            try {
                return _createLW.apply(this, arguments);
            } finally {
                Window_Command.prototype.initialize = _initialize;
            }
        };
        Scene_License._jtDarkPlasma_LicenseManagerPatched = true;
    }

    //DarkPlasma_NameWindow.js
    //2.1.1
    //MV
    //autoDetectName can still be problematic
    function patch_DarkPlasma_NameWindow() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Window_Message.prototype.findNameWindowTextInfo !== 'function' ||
            typeof Window_Message.prototype.convertNameWindow !== 'function' ||
            typeof Game_Actors.prototype.byName !== 'function' ||
            Window_Message._jtDarkPlasma_NameWindowPatched
        ) return;
        const rawLogic = callback =>
            TranslationManager.fetchRawData(() =>
                TranslationManager.disablePluginTrans(callback)
            );
        const _byName = Game_Actors.prototype.byName;
        Game_Actors.prototype.byName = function (name) {
            return rawLogic(() => _byName.call(this, name));
        }
        const _findNWTI = Window_Message.prototype.findNameWindowTextInfo;
        const infosPatched = new WeakSet();
        Window_Message.prototype.findNameWindowTextInfo = function (text) {
            const info = rawLogic(() => _findNWTI.call(this, text));
            if (!info || infosPatched.has(info)) return info;
            infosPatched.add(info);
            const _coloredName = info.coloredName;
            info.coloredName = function () {
                const source = rawLogic(() => _coloredName.call(this));
                if (TranslationManager._translationDisableDepth > 0 || TranslationManager.isRawData()) {
                    return source;
                }
                return TranslationManager.translate(source);
            }
            return info;
        }
        const _CEC = Window_Message.prototype.convertEscapeCharacters
        Window_Message.prototype.convertEscapeCharacters = function (text) {
            if (
                TranslationManager._translationDisableDepth > 0 ||
                TranslationManager._translatedSkipDepth > 0 ||
                TranslationManager.isRawData()
            ) return _CEC.apply(this, arguments);
            const body = rawLogic(() => _CEC.apply(this, arguments));
            const source = body.replace(/\\/g, '\\\\').replace(/\x1b/g, '\\');
            const translated = TranslationManager.translate(source);
            const converted = TranslationManager.skipPluginTrans(() => {
                return Window_Base.prototype.convertEscapeCharacters.call(this, translated);
            });
            TranslationManager.pushConvertedText(converted);
            TranslationManager._pushRecent(converted);
            return converted;
        }
        const _createSW = Window_Message.prototype.createSubWindows;
        Window_Message.prototype.createSubWindows = function () {
            const result = _createSW.apply(this, arguments);
            const nameWindow = this._nameWindow;
            if (nameWindow && !nameWindow._jtNameWindowDrawPatched) {
                const _drawTE = nameWindow.drawTextEx;
                nameWindow.drawTextEx = function () {
                    return TranslationManager.disablePluginTrans(() => {
                        return _drawTE.apply(this, arguments);
                    })
                };
                nameWindow._jtNameWindowDrawPatched = true;
            }
            return result;
        }
        Window_Message._jtDarkPlasma_NameWindowPatched = true;
    }

    //DarkPlasma_NameWindow.js
    //2.1.1
    //MZ
    //similar to MV variant, but logic only
    function patch_DarkPlasma_NameWindow_MZ() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Actors.prototype.byName !== 'function' ||
            typeof Window_Message.prototype.findNameWindowTextInfo !== 'function' ||
            typeof Window_Message.prototype.convertNameWindow !== 'function' ||
            Window_Message._jtDarkPlasma_NameWindowMZPatched
        ) return;
        const rawLogic = callback =>
            TranslationManager.fetchRawData(() =>
                TranslationManager.disablePluginTrans(callback)
            );
        const _byName = Game_Actors.prototype.byName;
        Game_Actors.prototype.byName = function (name) {
            return rawLogic(() => _byName.call(this, name));
        }
        const _CEC = Window_Message.prototype.convertEscapeCharacters;
        Window_Message.prototype.convertEscapeCharacters = function () {
            if (
                TranslationManager._translationDisableDepth > 0 ||
                TranslationManager._translatedSkipDepth > 0 ||
                TranslationManager.isRawData()
            ) return _CEC.apply(this, arguments);
            const body = rawLogic(() => _CEC.apply(this, arguments));
            const source = body.replace(/\\/g, '\\\\').replace(/\x1b/g, '\\');
            const translated = TranslationManager.translate(source);
            const converted = TranslationManager.skipPluginTrans(() => {
                return Window_Base.prototype.convertEscapeCharacters.call(this, translated);
            });
            TranslationManager.pushConvertedText(converted);
            TranslationManager._pushRecent(converted);
            return converted;
        }
        Window_Message._jtDarkPlasma_NameWindowMZPatched = true;
    }

    //DarkPlasma_AutoLineBreak.js
    //1.0.1
    //MV
    function patch_DarkPlasma_AutoLineBreak() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Window_Base.prototype.textWidthExCheck !== 'function' ||
            typeof Window_Base.prototype.mustLineBreak !== 'function' ||
            typeof Window_Base.prototype.isAutoLineBreakEnabled !== 'function' ||
            Window_Base.DarkPlasma_AutoLineBreakPatched
        ) return;
        const _textWEC = Window_Base.prototype.textWidthExCheck;
        Window_Base.prototype.textWidthExCheck = function () {
            return TranslationManager.disablePluginTrans(() => {
                return _textWEC.apply(this, arguments);
            })
        };
        const _processNC = Window_Base.prototype.processNormalCharacter;
        Window_Base.prototype.processNormalCharacter = function () {
            if (!this.isAutoLineBreakEnabled()) {
                return _processNC.apply(this, arguments);
            }
            return TranslationManager.disablePluginTrans(() => {
                return _processNC.apply(this, arguments);
            })
        };
        Window_Base.DarkPlasma_AutoLineBreakPatched = true;
    }

    //DarkPlasma_TextLog.js
    //3.2.0
    //MV
    function patch_DarkPlasma_TextLog() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_EventTextLog === 'undefined' ||
            typeof Window_TextLog === 'undefined' ||
            Game_EventTextLog._jtDarkPlasma_TextLogPatched
        ) return;
        const parameters = PluginManager.parameters('DarkPlasma_TextLog');
        const choiceFormat = String(parameters.choiceFormat || '選択肢:{choice}');
        const choiceCancelText = String(parameters.choiceCancelText || 'キャンセル');
        const choiceColor = Number(parameters.choiceColor || 17);
        const _transforms = [];
        function withLogTransform(transform, callback) {
            _transforms.push(transform);
            try {
                return callback();
            } finally {
                _transforms.pop();
            }
        }
        function translateChoiceFormat() {
            const ranges = [];
            const pattern = /{choice}/gi;
            let match;
            while ((match = pattern.exec(choiceFormat))) {
                ranges.push([match.index, pattern.lastIndex]);
            }
            //if choice format preserved through trans, proceed
            const translated = TranslationManager.translate(choiceFormat);
            if ((translated.match(/{choice}/gi) || []).length === ranges.length) {
                return translated;
            }
            return ranges.length ? TranslationManager.translate(choiceFormat, true, Infinity, true, ranges) : choiceFormat;
        }
        const _logProto = Game_EventTextLog.prototype;
        const _addML = _logProto.addMessageLog;
        _logProto.addMessageLog = function (text) {
            const transform = _transforms[_transforms.length - 1];
            const displayText = transform ? transform(text) : TranslationManager.translate(text);
            return _addML.call(this, displayText);
        }
        [
            Window_Message.prototype,
            Window_ScrollText.prototype
        ].forEach(prototype => {
            const _terminateMsg = prototype.terminateMessage;
            prototype.terminateMessage = function () {
                return withLogTransform(text => text, () => _terminateMsg.apply(this, arguments));
            }
        });
        const _addTL = Window_ChoiceList.prototype.addToLog;
        Window_ChoiceList.prototype.addToLog = function () {
            return withLogTransform(() => {
                const chosenIndex = $gameMessage.chosenIndex();
                const choices = $gameMessage.choices();
                const cancelled = chosenIndex === $gameMessage.choiceCancelType() && (chosenIndex < 0 || choices.length <= chosenIndex);
                const text = cancelled ? choiceCancelText : choices[chosenIndex];
                return translateChoiceFormat().replace(/{choice}/gi, '\x1bC[' + choiceColor + ']' + TranslationManager.translate(text) + '\x1bC[0]');
            }, () => _addTL.apply(this, arguments));
        }
        const _windowPrototype = Window_TextLog.prototype;
        ['calcMessageHeight', 'drawTextEx'].forEach(method => {
            const _method = _windowPrototype[method];
            _windowPrototype[method] = function () {
                return TranslationManager.skipPluginTrans(() => {
                    return _method.apply(this, arguments);
                })
            }
        });
        Game_EventTextLog._jtDarkPlasma_TextLogPatched = true;
    }

    //DarkPlasma_TextLog.js
    //2.3.2
    //MZ
    function patch_DarkPlasma_TextLog_MZ() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_EventTextLog === 'undefined' ||
            typeof Game_LogMessage === 'undefined' ||
            typeof Scene_TextLog === 'undefined' ||
            typeof Game_Message.prototype.chosenText !== 'function' ||
            Game_EventTextLog._jtDarkPlasma_TextLogMZPatched
        ) return;
        const _insertTL = PluginManager._commands['DarkPlasma_TextLog:insertTextLog'];
        if (typeof _insertTL !== 'function') return;
        const params = PluginManager.parameters('DarkPlasma_TextLog');
        const choiceFormat = String(params.choiceFormat || '選択肢:{choice}');
        const choiceColor = Number(params.choiceColor || 17);
        const displayTexts = new WeakMap();
        const frames = [];
        const joinText = (speakerName, text) => [speakerName, text].filter(text => text).join('\n');
        const rawLogic = callback => TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(callback));
        function _captureLogText(target, callback) {
            const frame = { converted: [] };
            const descriptor = Object.getOwnPropertyDescriptor(target, 'convertEscapeCharacters');
            const convertEscapeCharacters = target.convertEscapeCharacters;
            target.convertEscapeCharacters = function () {
                const displayText = convertEscapeCharacters.apply(this, arguments);
                const rawText = rawLogic(() => convertEscapeCharacters.apply(this, arguments));
                frame.converted.push(displayText);
                return rawText;
            };
            frames.push(frame);
            try {
                return callback();
            } finally {
                frames.pop();
                if (descriptor) {
                    Object.defineProperty(target, 'convertEscapeCharacters', descriptor);
                } else {
                    delete target.convertEscapeCharacters;
                }
            }
        }
        function _translateChoiceFormat() {
            const ranges = [];
            const pattern = /{choice}/gi;
            let match;
            while ((match = pattern.exec(choiceFormat))) {
                ranges.push([match.index, pattern.lastIndex]);
            }
            const translated = TranslationManager.translate(choiceFormat);
            if ((translated.match(/{choice}/gi) || []).length === ranges.length) {
                return translated;
            }
            return TranslationManager.translate(
                choiceFormat, true, Infinity, true, ranges
            );
        }
        const _terminateMsg = Window_Message.prototype.terminateMessage;
        Window_Message.prototype.terminateMessage = function () {
            return _captureLogText(this, () => _terminateMsg.apply(this, arguments));
        };
        const _chosenText = Game_Message.prototype.chosenText;
        Game_Message.prototype.chosenText = function () {
            const text = _chosenText.apply(this, arguments);
            const frame = frames[frames.length - 1];
            if (frame) frame.choiceText = text;
            return text;
        };
        PluginManager._commands['DarkPlasma_TextLog:insertTextLog'] = function () {
            return _captureLogText(Window_Base.prototype, () => _insertTL.apply(this, arguments));
        };
        const _pushLog = Game_EventTextLog.prototype.pushLog;
        Game_EventTextLog.prototype.pushLog = function (speakerName, text) {
            const frame = frames[frames.length - 1];
            let displayText;
            if (frame && frame.converted.length) {
                displayText = frame.converted.splice(0).filter(text => text).join('\n');
            } else if (frame && 'choiceText' in frame) {
                const choice = TranslationManager.translate(frame.choiceText);
                delete frame.choiceText;
                displayText = _translateChoiceFormat().replace(/{choice}/gi, '\x1bC[' + choiceColor + ']' + choice + '\x1bC[0]');
            } else {
                displayText = joinText(TranslationManager.translate(speakerName), TranslationManager.translate(text));
            }
            const result = _pushLog.apply(this, arguments);
            const message = this.messages[this.messages.length - 1];
            if (message) displayTexts.set(message, displayText);
            return result;
        };
        const _logText = Game_LogMessage.prototype.text;
        Game_LogMessage.prototype.text = function () {
            return displayTexts.has(this) ? displayTexts.get(this) : _logText.apply(this, arguments);
        };
        const _createTLW = Scene_TextLog.prototype.createTextLogWindow;
        Scene_TextLog.prototype.createTextLogWindow = function () {
            const result = TranslationManager.skipPluginTrans(() => {
                return _createTLW.apply(this, arguments);
            });
            const window = this._textLogWindow;
            ['calcMessageHeight', 'drawTextEx'].forEach(function (method) {
                const ori = window[method];
                window[method] = function () {
                    return TranslationManager.skipPluginTrans(() => {
                        return ori.apply(this, arguments);
                    })
                }
            })
            return result;
        };
        Game_EventTextLog._jtDarkPlasma_TextLogMZPatched = true;
    }

    //DarkPlasma_SkillDetail.js
    //2.0.2
    //MV
    //for repeated trans
    function patch_DarkPlasma_SkillDetail() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Window_SkillDetail === 'undefined' ||
            typeof Window_SkillDetail.prototype.processCharacter !== 'function' ||
            Window_SkillDetail._jtDarkPlasma_SkillDetailPatched
        ) return;
        const _processC = Window_SkillDetail.prototype.processCharacter;
        Window_SkillDetail.prototype.processCharacter = function () {
            return TranslationManager.disablePluginTrans(() => {
                return _processC.apply(this, arguments);
            })
        }
        Window_SkillDetail._jtDarkPlasma_SkillDetailPatched = true;
    }

    //DarkPlasma_ComposePicture.js
    //1.1.3
    //MZ
    function patch_DarkPlasma_ComposePicture() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_AdditionalPicture === 'undefined' ||
            typeof Game_AdditionalPicture.prototype.name !== 'function' ||
            Game_AdditionalPicture._jtDarkPlasma_ComposePicturePatched
        ) return;
        const _name = Game_AdditionalPicture.prototype.name;
        Game_AdditionalPicture.prototype.name = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _name.apply(this, arguments);
                })
            })
        }
        Game_AdditionalPicture._jtDarkPlasma_ComposePicturePatched = true;
    }

    //DarkPlasma_PartialTextColor.js
    //1.0.0
    //MZ
    //not sure if we should provide patch for this
    //usually not plugin d modify bitmap drawtext so should be fine ig?
    function patch_DarkPlasma_PartialTextColor() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Bitmap.prototype.drawTextWithPartialColor !== 'function' ||
            Bitmap._jtDarkPlasma_PartialTextColorPatched
        ) return;
        const _drawTextWPC = Bitmap.prototype.drawTextWithPartialColor;
        Bitmap.prototype.drawTextWithPartialColor = function (text, x, y, maxWidth, lineHeight, align) {
            if (
                typeof text === 'string' &&
                TranslationManager._translationDisableDepth === 0 &&
                TranslationManager._translatedSkipDepth === 0 &&
                !TranslationManager._inRecent(text)
            ) {
                text = TranslationManager.translate(text);
            }
            return _drawTextWPC.call(this, text, x, y, maxWidth, lineHeight, align);
        }
        Bitmap._jtDarkPlasma_PartialTextColorPatched = true;
    }

    //DarkPlasma_AutoHighlight.js
    //2.5.0
    //MZ
    //MZ variant has reachable highlightwords
    function patch_DarkPlasma_AutoHighlight() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            !globalThis.highlightWords ||
            typeof Scene_Boot.prototype.setupHighlightWords !== 'function' ||
            globalThis.highlightWords._jtDarkPlasma_AutoHighlightPatched
        ) return;
        const words = globalThis.highlightWords;
        const rawLogic = callback => TranslationManager.fetchRawData(() =>
            TranslationManager.disablePluginTrans(callback)
        );
        const isRawLogic = () => TranslationManager.isRawData() || TranslationManager._translationDisableDepth > 0;
        const _setupHL = Scene_Boot.prototype.setupHighlightWords;
        Scene_Boot.prototype.setupHighlightWords = function () {
            return rawLogic(() => _setupHL.apply(this, arguments));
        }
        let displayWords = null;
        const getDisplayWords = () => {
            if (!displayWords) {
                displayWords = new words.constructor();
                const entries = TranslationManager.fetchRawData(() =>
                    words._highlightWords.map(entry => ({
                        source: entry.word,
                        entry
                    }))
                );
                entries.forEach(({ source, entry }) => {
                    const word = TranslationManager.translate(source);
                    if (word) {
                        displayWords.add({
                            word,
                            get color() { return entry.color; }
                        });
                    }
                });
            }
            return displayWords;
        };
        ['add', 'refreshCache'].forEach(method => {
            const ori = words[method];
            words[method] = function () {
                displayWords = null;
                return ori.apply(this, arguments);
            }
        });
        let displayDepth = 0;
        const withDisplayWords = callback => {
            displayDepth++;
            try {
                return callback();
            } finally {
                displayDepth--
            }
        };
        ['sortedWords', 'findColorByWord'].forEach(method => {
            const ori = words[method];
            words[method] = function () {
                if (displayDepth > 0 && !isRawLogic()) {
                    return getDisplayWords()[method](...arguments);
                }
                return ori.apply(this, arguments);
            };
        });
        const _highlightT = words.highlightText;
        words.highlightText = function (text) {
            if (displayDepth > 0 && !isRawLogic()) {
                if (!getDisplayWords().sortedWords().length) return text;
                const result = _highlightT.call(this, text);
                TranslationManager.pushConvertedText(result);
                return result;
            }
            return _highlightT.call(this, text);
        };
        const _CEC = Window_Base.prototype.convertEscapeCharacters;
        Window_Base.prototype.convertEscapeCharacters = function () {
            return withDisplayWords(() => _CEC.apply(this, arguments));
        };
        const _drawText = Window_Base.prototype.drawText;
        Window_Base.prototype.drawText = function (text, ...args) {
            if (
                !this.isHighlightWindow() ||
                isRawLogic() ||
                TranslationManager._translatedSkipDepth > 0
            ) {
                return withDisplayWords(() => _drawText.call(this, text, ...args));
            }
            const translated = TranslationManager.translate(text);
            return withDisplayWords(() => TranslationManager.skipPluginTrans(() => _drawText.call(this, translated, ...args)));
        };
        const _flushTS = Window_Base.prototype.flushTextState;
        Window_Base.prototype.flushTextState = function () {
            if (this.isHighlightWindow() && !isRawLogic()) {
                return TranslationManager.skipPluginTrans(() => {
                    return _flushTS.apply(this, arguments);
                });
            }
            return _flushTS.apply(this, arguments);
        };
        globalThis.highlightWords._jtDarkPlasma_AutoHighlightPatched = true;
    }

    //DarkPlasma_DisplayDatabaseDetailWindow.js
    //1.1.0
    //MZ
    function patch_DarkPlasma_DisplayDatabaseDetailWindow() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            !globalThis.Window_DetailText ||
            globalThis.Window_DetailText._jtDarkPlasma_DisplayDatabaseDetailWindowPatched
        ) return;
        const _prototype = globalThis.Window_DetailText.prototype;
        const _canTranslate = () => !TranslationManager.isRawData() && TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0;
        const _detailText = _prototype.detailText;
        _prototype.detailText = function (item) {
            if (!_canTranslate()) {
                return _detailText.apply(this, arguments);
            }
            const source = String((item ? item.meta.detail : '') || '');
            const translated = TranslationManager.translate(source);
            const result = this.mustTrimText() ? translated.trim() : translated;
            TranslationManager._translatedSet.add(result);
            return result;
        };
        const _setText = _prototype.setText;
        _prototype.setText = function (text) {
            return _setText.call(this, _canTranslate() ? TranslationManager.translate(text) : text);
        };
        ['drawDetail', 'overallHeight'].forEach(method => {
            const ori = _prototype[method];
            _prototype[method] = function () {
                return TranslationManager.skipPluginTrans(() => ori.apply(this, arguments));
            }
        });
        globalThis.Window_DetailText._jtDarkPlasma_DisplayDatabaseDetailWindowPatched = true;
    }

    //DarkPlasma_ChoiceExtension.js
    //1.2.3
    //MZ
    function patch_DarkPlasma_ChoiceExtension() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Interpreter.prototype.evalChoiceCondition !== 'function' ||
            typeof Game_Interpreter.prototype.mergeSequencialChoices !== 'function' ||
            Game_Interpreter._jtDarkPlasma_ChoiceExtensionPatched
        ) return;
        const _evalCC = Game_Interpreter.prototype.evalChoiceCondition;
        Game_Interpreter.prototype.evalChoiceCondition = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _evalCC.apply(this, arguments);
                })
            })
        };
        const _CEC = Window_ChoiceList.prototype.convertEscapeCharacters;
        Window_ChoiceList.prototype.convertEscapeCharacters = function () {
            const text = _CEC.apply(this, arguments);
            if (!TranslationManager.isRawData() && TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0) {
                TranslationManager.pushConvertedText(text);
                TranslationManager._pushRecent(text);
            }
            return text;
        };
        Game_Interpreter._jtDarkPlasma_ChoiceExtensionPatched = true;
    }

    //DarkPlasma_FormationInBattle.js
    //3.0.1
    //MZ
    function patch_DarkPlasma_FormationInBattle() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Window_PartyCommand.prototype.addCommandAt !== 'function' ||
            typeof Window_PartyCommand.prototype.isFormationEnabled !== 'function' ||
            Window_PartyCommand._jtDarkPlasma_FormationInBattlePatched
        ) return;
        const _addCA = Window_PartyCommand.prototype.addCommandAt;
        Window_PartyCommand.prototype.addCommandAt = function (index, name, symbol, enabled = true, ext = null) {
            if (symbol === 'formation' &&
                typeof name === 'string' &&
                !TranslationManager.isRawData() &&
                TranslationManager._translationDisableDepth === 0 &&
                TranslationManager._translatedSkipDepth === 0
            ) {
                const label = TextManager.formation;
                if (name.startsWith(label)) {
                    const suffix = name.slice(label.length);
                    name = label + TranslationManager.translate(suffix);
                    TranslationManager._translatedSet.add(name);
                }
            }
            return _addCA.call(this, index, name, symbol, enabled, ext);
        };
        Window_PartyCommand._jtDarkPlasma_FormationInBattlePatched = true;
    }

    //TorigoyaMZ_Bookshelf.js
    //1.2.2
    //MZ
    //full page in one CEC call from Window_BookContent.drawItem
    //hope nobody d use /V[n] or /N[n] in file name
    function patch_TorigoyaMZ_Bookshelf() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Torigoya === 'undefined' ||
            !Torigoya.Bookshelf ||
            !Torigoya.Bookshelf.Window_BookContent ||
            Torigoya._jtTorigoyaMZ_BookshelfPatched
        ) return;
        const _prototype = Torigoya.Bookshelf.Window_BookContent.prototype;
        let bookshelfMaskDepth = 0;
        function _collectImageMask(text) {
            const masks = [];
            let index = 0;
            while (index < text.length) {
                const character = text[index];
                if (character !== '\\' && character !== '\x1b') {
                    index++;
                    continue;
                }
                const nextCharacter = text[index + 1];
                if (nextCharacter === '\\' || nextCharacter === '\x1b') {
                    index += 2;
                    continue;
                }
                const code = /^[A-Z]+/i.exec(text.slice(index + 1));
                if (!code) { index++; continue; }
                const name = code[0].toUpperCase();
                if (name !== 'BOOKFACE' && name !== 'BOOKPICTURE') {
                    index += code[0].length + 1;
                    continue;
                }
                const lineEnd = text.indexOf('\n', index);
                const end = lineEnd < 0 ? text.length : lineEnd;
                masks.push([index, end]);
                index = end;
            }
            return masks;
        };
        const _translate = TranslationManager.translate;
        TranslationManager.translate = function (text, detectStartWhitespace, times, cache, mask) {
            if (bookshelfMaskDepth > 0 && typeof text === 'string') {
                const imageMasks = _collectImageMask(text);
                if (imageMasks.length > 0) {
                    const args = Array.prototype.slice.call(arguments);
                    args[4] = (mask == null ? [] : mask).concat(imageMasks);
                    return _translate.apply(this, args);
                }
            }
            return _translate.apply(this, arguments);
        };
        const _CEC = _prototype.convertEscapeCharacters;
        _prototype.convertEscapeCharacters = function () {
            bookshelfMaskDepth++;
            try {
                return _CEC.apply(this, arguments);
            } finally {
                bookshelfMaskDepth--;
            }
        };
        const _flushTS = _prototype.flushTextState;
        _prototype.flushTextState = function () {
            return TranslationManager.skipPluginTrans(() => {
                return _flushTS.apply(this, arguments);
            })
        };
        Torigoya._jtTorigoyaMZ_BookshelfPatched = true;
    }

    //Torigoya_Bookshelf.js
    //1.2.2
    //MV
    function patch_Torigoya_Bookshelf() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Torigoya === 'undefined' ||
            !Torigoya.Bookshelf ||
            !Torigoya.Bookshelf.Window_BooksList ||
            !Torigoya.Bookshelf.Window_BookContent ||
            Torigoya._jtTorigoya_BookshelfPatched
        ) return;
        const _makeIL = Torigoya.Bookshelf.Window_BooksList.prototype.makeItemList;
        Torigoya.Bookshelf.Window_BooksList.prototype.makeItemList = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _makeIL.apply(this, arguments);
                })
            })
        };
        function _collectImageRanges(text) {
            const ranges = [];
            let index = 0;
            while (index < text.length) {
                const character = text[index];
                if (character !== '\\' && character !== '\x1b') {
                    index++;
                    continue;
                }
                const nextCharacter = text[index + 1];
                if (nextCharacter === '\\' || nextCharacter === '\x1b') {
                    index += 2;
                    continue;
                }
                const code = /^[A-Z]+/i.exec(text.slice(index + 1));
                if (!code) {
                    index++;
                    continue;
                }
                if (!/^BOOK(?:FACE|PICTURE)$/i.test(code[0])) {
                    index += code[0].length + 1;
                    continue;
                }
                const lineEnd = text.indexOf('\n', index);
                const end = lineEnd < 0 ? text.length : lineEnd;
                ranges.push([index, end]);
                index = end;
            }
            return ranges;
        };
        function _translatePage(text) {
            const imageMasks = _collectImageRanges(text);
            if (!imageMasks.length) {
                return TranslationManager.translate(text);
            }
            return TranslationManager.translate(text, true, Infinity, true, imageMasks);
        };
        const _CEC = Torigoya.Bookshelf.Window_BookContent.prototype.convertEscapeCharacters;
        Torigoya.Bookshelf.Window_BookContent.prototype.convertEscapeCharacters = function (text) {
            if (
                typeof text !== 'string' ||
                TranslationManager._translationDisableDepth > 0 ||
                TranslationManager._translatedSkipDepth > 0
            ) {
                return _CEC.apply(this, arguments);
            }
            //could be risky but give it a try
            const translated = _translatePage(text);
            const ranges = _collectImageRanges(translated);
            const result = [];
            let offset = 0;
            const _convertDisplayText = part => {
                return TranslationManager.skipPluginTrans(() => {
                    return _CEC.call(this, part);
                })
            };
            const _convertImageCommand = part => {
                return TranslationManager.fetchRawData(() => {
                    return TranslationManager.disablePluginTrans(() => {
                        return _CEC.call(this, part);
                    })
                })
            };
            ranges.forEach(range => {
                if (range[0] > offset) {
                    result.push(_convertDisplayText(translated.slice(offset, range[0])));
                }
                result.push(_convertImageCommand(translated.slice(range[0], range[1])));
                offset = range[1];
            });
            if (offset < translated.length) {
                result.push(_convertDisplayText(translated.slice(offset)));
            }
            return result.join('');
        };
        const _processNC = Torigoya.Bookshelf.Window_BookContent.prototype.processNormalCharacter;
        Torigoya.Bookshelf.Window_BookContent.prototype.processNormalCharacter = function () {
            return TranslationManager.skipPluginTrans(() => {
                return _processNC.apply(this, arguments);
            })
        };
        Torigoya._jtTorigoya_BookshelfPatched = true;
    }

    //Torigoya_SkillCutIn.js
    //1.4.0
    //MV
    function patch_Torigoya_SkillCutIn() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Torigoya === 'undefined' ||
            !Torigoya.SkillCutIn ||
            !Torigoya.SkillCutIn.CutInManager ||
            typeof Torigoya.SkillCutIn.CutInManager.canPlayConfig !== 'function' ||
            Torigoya._jtTorigoya_SkillCutInPatched
        ) return;
        const _canPC = Torigoya.SkillCutIn.CutInManager.canPlayConfig;
        Torigoya.SkillCutIn.CutInManager.canPlayConfig = function () {
            return TranslationManager.fetchRawData(() => {
                return _canPC.apply(this, arguments);
            })
        };
        Torigoya._jtTorigoya_SkillCutInPatched = true;
    }

    //Torigoya_SkillChangeTo.js
    //1.1.0
    //MV
    function patch_Torigoya_SkillChangeTo() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof BattleManager.torigoyaSkillChangeToApply !== 'function' ||
            BattleManager._jtTorigoya_SkillChangeToPatched
        ) return;
        const _torigoyaSCTA = BattleManager.torigoyaSkillChangeToApply;
        BattleManager.torigoyaSkillChangeToApply = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _torigoyaSCTA.apply(this, arguments);
                })
            })
        };
        BattleManager._jtTorigoya_SkillChangeToPatched = true;
    }

    //Torigoya_Achievement2.js
    //1.8.2
    //MV
    function patch_Torigoya_Achievement2() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Torigoya === 'undefined' ||
            !Torigoya.Achievement2 ||
            !Torigoya.Achievement2.Window_AchievementPopup ||
            !Torigoya.Achievement2.Window_AchievementList ||
            Torigoya._jtTorigoya_Achievement2Patched
        ) return;
        const _shouldSkip = () => {
            return TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0;
        };
        const _drawTitle = Torigoya.Achievement2.Window_AchievementPopup.prototype.drawTitle;
        Torigoya.Achievement2.Window_AchievementPopup.prototype.drawTitle = function () {
            if (_shouldSkip()) {
                return _drawTitle.apply(this, arguments);
            }
            this.resetFontSettings();
            const title = TranslationManager.translate(this._item.achievement.title);
            const prefix = '\\c[' + Torigoya.Achievement2.parameter.popupTitleColor + ']';
            return TranslationManager.skipPluginTrans(() => {
                return this.drawTextEx(prefix + title, 40, 0);
            });
        };
        const _patchedWindows = new WeakSet();
        const _updateHelp = Torigoya.Achievement2.Window_AchievementList.prototype.updateHelp;
        Torigoya.Achievement2.Window_AchievementList.prototype.updateHelp = function () {
            const helpWindow = this._helpWindow;
            if (helpWindow && !_patchedWindows.has(helpWindow)) {
                const _drawTextEx = helpWindow.drawTextEx;
                helpWindow.drawTextEx = function (text) {
                    if (_shouldSkip()) {
                        return _drawTextEx.apply(this, arguments);
                    }
                    const _drawArguments = Array.prototype.slice.call(arguments);
                    _drawArguments[0] = TranslationManager.translate(text);
                    return TranslationManager.skipPluginTrans(() => {
                        return _drawTextEx.apply(this, _drawArguments);
                    })
                };
                _patchedWindows.add(helpWindow);
            }
            return _updateHelp.apply(this, arguments);
        };
        Torigoya._jtTorigoya_Achievement2Patched = true;
    }

    //NUUN_CallingEnemy.js
    //1.1.0
    //MZ
    function patch_NUUN_CallingEnemy() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Imported === 'undefined' ||
            !Imported.NUUN_CallingEnemy ||
            typeof Game_Action.prototype.isCallEnemy !== 'function' ||
            typeof Game_Action.prototype.getCallEnemyLottery !== 'function' ||
            typeof Game_Troop.prototype.isCallEnemy !== 'function' ||
            typeof Game_Action.prototype.setAppearEnemyMessage !== 'function' ||
            Game_Action._jtNUUN_CallingEnemyPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        Game_Action.prototype.isCallEnemy = wrapRaw(Game_Action.prototype.isCallEnemy);
        Game_Action.prototype.getCallEnemyLottery = wrapRaw(Game_Action.prototype.getCallEnemyLottery);
        Game_Troop.prototype.isCallEnemy = wrapRaw(Game_Troop.prototype.isCallEnemy);
        Game_Troop.prototype.makeUniqueNames = wrapRaw(Game_Troop.prototype.makeUniqueNames);//risky ig
        Game_Action.prototype.setAppearEnemyMessage = wrapRaw(Game_Action.prototype.setAppearEnemyMessage);
        Game_Action._jtNUUN_CallingEnemyPatched = true;
    }

    //NUUN_ItemBook.js
    //1.6.6
    //MZ
    function patch_NUUN_ItemBook() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Window_ItemBook_Index === 'undefined' ||
            Window_ItemBook_Index._jtNUUN_ItemBookPatched
        ) return;
        const _patchedPrototypes = new WeakSet();
        const _itemNL = Window_ItemBook_Index.prototype.itemNameLength;
        Window_ItemBook_Index.prototype.itemNameLength = function () {
            return TranslationManager.fetchRawData(() => {
                return _itemNL.apply(this, arguments);
            });
        };
        function _patchDetailWindow(itemWindow) {
            if (!itemWindow) return;
            const _detailProto = Object.getPrototypeOf(itemWindow);
            if (!_detailProto || _patchedPrototypes.has(_detailProto) || typeof _detailProto.dataDisplay !== 'function') return;
            const _dataDisplay = _detailProto.dataDisplay;
            _detailProto.dataDisplay = function () {
                return TranslationManager.fetchRawData(() => {
                    return _dataDisplay.apply(this, arguments);
                });
            };
            const _drawTE = _detailProto.drawTextEx;
            _detailProto.drawTextEx = function () {
                return TranslationManager.fetchTranslatedData(() => {
                    return _drawTE.apply(this, arguments);
                });
            };
            _patchedPrototypes.add(_detailProto);
        };
        const _setIW = Window_ItemBook_Index.prototype.setItemWindow;
        Window_ItemBook_Index.prototype.setItemWindow = function (itemWindow) {
            _patchDetailWindow(itemWindow);
            return _setIW.apply(this, arguments);
        };
        Window_ItemBook_Index._jtNUUN_ItemBookPatched = true;
    }

    //NUUN_EnemyBook.js
    //2.23.4
    //MZ
    function patch_NUUN_EnemyBook() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Imported === 'undefined' ||
            !Imported.NUUN_EnemyBook ||
            typeof Window_EnemyBook_Index === 'undefined' ||
            Window_EnemyBook_Index._jtNUUN_EnemyBookPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        [
            'initialize',
            'isEnemyBook',
            'isEnemyBookData',
            'isInEnemyBook',
            'isInEnemyBookStatus',
            'noEnemyBookEnemyName',
            'setDefeatEnemy'
        ].forEach(name => {
            if (typeof Game_System.prototype[name] === 'function') {
                Game_System.prototype[name] = wrapRaw(Game_System.prototype[name]);
            }
        });
        DataManager.extractSaveContents = wrapRaw(DataManager.extractSaveContents);
        Window_EnemyBook_Index.prototype.EnemyNameLength = wrapRaw(Window_EnemyBook_Index.prototype.EnemyNameLength);
        if (typeof Window_EnemyBook_Index.prototype.itemListNameOrder === 'function') {
            Window_EnemyBook_Index.prototype.itemListNameOrder = wrapRaw(Window_EnemyBook_Index.prototype.itemListNameOrder);
        }
        const _contentWindows = new WeakSet();
        const _prepareContentWindow = function (bookWindow) {
            if (!bookWindow || _contentWindows.has(bookWindow)) return;
            [
                'dropItems',
                'stealItems',
                'condDropItems',
                'enemyAction'
            ].forEach(name => {
                if (typeof bookWindow[name] === 'function') {
                    bookWindow[name] = wrapRaw(bookWindow[name]);
                }
            });
            if (typeof bookWindow.enemyName === 'function') {
                bookWindow.enemyName = wrapRaw(bookWindow.enemyName);
            }
            _contentWindows.add(bookWindow);
        };
        const _indexWindows = new WeakSet();
        const _initialize = Window_EnemyBook_Index.prototype.initialize;
        Window_EnemyBook_Index.prototype.initialize = function () {
            const result = _initialize.apply(this, arguments);
            if (!_indexWindows.has(this)) {
                this.drawItem = wrapRaw(this.drawItem);
                _indexWindows.add(this);
            }
            return result;
        };
        const _setEW = Window_EnemyBook_Index.prototype.setEnemyWindow;
        Window_EnemyBook_Index.prototype.setEnemyWindow = function (bookWindow) {
            _prepareContentWindow(bookWindow);
            return _setEW.apply(this, arguments);
        };
        const _setEBW = BattleManager.setEnemyBookWinsow;//upstream typo
        BattleManager.setEnemyBookWinsow = function (bookWindow) {
            _prepareContentWindow(bookWindow);
            return _setEBW.apply(this, arguments);
        };
        Game_Action.prototype.analyzeSkill = wrapRaw(Game_Action.prototype.analyzeSkill);
        const _percentWindows = new WeakSet();
        const _preparePercentWindow = function (percentWindow) {
            if (!percentWindow || _percentWindows.has(percentWindow)) return;
            const _getPP = percentWindow.getPercentParam;
            percentWindow.getPercentParam = function (content) {
                if (TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) {
                    return _getPP.apply(this, arguments);
                }
                const _displayContent = content ? Object.assign({}, content) : { ContentDate: 0, ContentName: '完成度' };
                _displayContent.ContentName = TranslationManager.translate(_displayContent.ContentName);
                const result = _getPP.call(this, _displayContent);
                TranslationManager.pushConvertedText(result);
                return result;
            };
            _percentWindows.add(percentWindow);
        };
        const _setPW = Window_EnemyBook_Index.prototype.setPercentWindow;
        Window_EnemyBook_Index.prototype.setPercentWindow = function (percentWindow) {
            _preparePercentWindow(percentWindow);
            return _setPW.apply(this, arguments);
        };
        Window_EnemyBook_Index._jtNUUN_EnemyBookPatched = true;
    }

    //NUUN_MenuCommandEX.js
    //1.2.3
    //MZ
    function patch_NUUN_MenuCommandEX() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Imported === 'undefined' ||
            !Imported.NUUN_MenuCommandEX ||
            Window_MenuCommand._jtNUUN_MenuCommandEXPatched
        ) return;
        const _makeCL = Window_MenuCommand.prototype.makeCommandList;
        Window_MenuCommand.prototype.makeCommandList = function () {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _makeCL.apply(this, arguments);
                })
            })
        };
        Window_MenuCommand._jtNUUN_MenuCommandEXPatched = true;
    }

    //NUUN_MenuScreenEX.js
    //3.1.15
    //MZ
    function patch_NUUN_MenuScreenEX() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof Imported === "undefined" ||
            !Imported.NUUN_MenuScreenEX ||
            typeof Scene_Menu.prototype.updateCommandName !== "function" ||
            Scene_Menu._jtNUUN_MenuScreenEXPatched
        ) return;
        const rawLogic = callback => {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(callback);
            });
        };
        const rawReads = callback => {
            return TranslationManager.fetchRawData(callback);
        };
        function wrap(target, method, run) {
            const ori = target[method];
            if (typeof ori !== 'function') return;
            target[method] = function () {
                return run(() => ori.apply(this, arguments));
            };
        };
        wrap(Window_MenuCommand.prototype, 'makeCommandList', rawLogic);
        [
            'nuunMenu_isContents',
            'nuunMenu_drawMenuStatusImg'
        ].forEach(method => { wrap(Window_StatusBase.prototype, method, rawLogic) });
        [
            'nuun_DrawMenuStatusContentsOrgParam',
            'nuun_DrawMenuStatusContentsExp',
            'nuun_DrawMenuStatusContentsSkillPoint',
            'nuunMenu_drawParams',
            'nuunMenu_drawXParams',
            'nuunMenu_drawSParams'
        ].forEach(method => { wrap(Window_StatusBase.prototype, method, rawReads) });
        if (typeof Sprite_MenuGauge !== 'undefined') {
            [
                'currentValue',
                'currentMaxValue'
            ].forEach(method => { wrap(Sprite_MenuGauge.prototype, method, rawLogic) });
        }
        const _addW = Scene_Menu.prototype.addWindow;
        Scene_Menu.prototype.addWindow = function (window) {
            if (window && typeof window.nuun_DrawMenuInfoContentsOrgParam === 'function' && !window._jtNUUN_MenuScreenEXPatched) {
                wrap(window, 'nuun_DrawMenuInfoContentsOrgParam', rawReads);
                window._jtNUUN_MenuScreenEXPatched = true;
            }
            return _addW.apply(this, arguments);
        };
        Scene_Menu._jtNUUN_MenuScreenEXPatched = true;
    }

    //NUUN_StatusScreen.js
    //2.7.3
    //MZ
    //display related patch on hold cuz drawText(Ex) scope not clear under Window_Status
    function patch_NUUN_StatusScreen() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof Window_Status.prototype.nuunStatusActorImg !== 'function' ||
            Window_Status._jtNUUN_StatusScreenPatched
        ) return;
        ['dateDisplay', 'drawImg'].forEach(method => {
            const ori = Window_Status.prototype[method];
            if (typeof ori !== 'function') return;
            Window_Status.prototype[method] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            };
        });
        Window_Status._jtNUUN_StatusScreenPatched = true;
    }

    //NUUN_SystemDatabaseUnlimited.js
    //1.1.0
    //MZ
    function patch_NUUN_SystemDatabaseUnlimited() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            PluginManager._jtNUUN_SystemDatabaseUnlimitedPatched
        ) return;
        [
            'NUUN_SystemDatabaseUnlimited:DataBaseAddMaps',
            'NUUN_SystemDatabaseUnlimited:AddMap'
        ].forEach(method => {
            const ori = PluginManager._commands[method];
            if (typeof ori !== 'function') return;
            PluginManager._commands[method] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                })
            }
        });
        PluginManager._jtNUUN_SystemDatabaseUnlimitedPatched = true;
    }

    //NUUN_BattleStyleEX.js
    //1.1.2
    //MZ
    function patch_NUUN_BattleStyleEX() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof Imported === "undefined" ||
            !Imported.NUUN_BattleStyleEX ||
            typeof Nuun_DrawListData === "undefined" ||
            typeof Window_BattleActorStatus === "undefined" ||
            Nuun_DrawListData._jtNUUN_BattleStyleEXPatched
        ) return;
        const rawLogic = callback => {
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(callback);
            });
        };
        function switchWrap(target, method, gate) {
            const ori = target[method];
            if (typeof ori !== 'function') return;
            target[method] = function () {
                if (!gate(this)) {
                    return ori.apply(this, arguments);
                }
                return rawLogic(() => {
                    return ori.apply(this, arguments);
                });
            }
        };
        const _isBattleStatusData = data => { return data._window instanceof Window_BattleActorStatus };
        [
            "nuun_IsContents",
            "getStatusEvalParam"
        ].forEach(method => {
            switchWrap(Nuun_DrawListData.prototype, method, _isBattleStatusData);
        });
        if (typeof Sprite_NuunGauge !== 'undefined') {
            [
                "orgGaugeValue",
                "orgGaugeMaxValue"
            ].forEach(method => {
                switchWrap(Sprite_NuunGauge.prototype, method, () => SceneManager._scene instanceof Scene_Battle);
            });
        }
        Nuun_DrawListData._jtNUUN_BattleStyleEXPatched = true;
    }

    //LL_MenuScreenCustomMV.js
    //1.4.4
    //MV
    //LL_MenuScreenCustom.js
    //1.4.4
    //MZ
    function patch_LL_MenuScreenCustomMV() {
        if (
            typeof Scene_Menu.prototype.createMenuHelpWindow !== 'function' ||
            typeof Window_Command.prototype.currentName !== 'function' ||
            Scene_Menu._jtLL_MenuScreenCustomMVPatched
        ) return;
        const _pluginName = Utils.RPGMAKER_NAME === 'MZ' ? 'LL_MenuScreenCustom' : 'LL_MenuScreenCustomMV';
        const _params = PluginManager.parameters(_pluginName);
        const _entries = JSON.parse(_params.menuHelpTexts || '[]');
        const _sourceByTranslatedName = new Map();
        if (_entries) {
            _entries.forEach(entry => {
                const sourceName = String(JSON.parse(entry).symbol);
                const translatedName = TranslationManager.translate(sourceName);
                _sourceByTranslatedName.set(translatedName, sourceName);
            });
        }
        const _helpCommandWindows = new WeakSet();
        const _createMHW = Scene_Menu.prototype.createMenuHelpWindow;
        Scene_Menu.prototype.createMenuHelpWindow = function () {
            const result = TranslationManager.fetchRawData(() => {
                return _createMHW.apply(this, arguments);
            });
            if (this._menuHelpWindow && !this._menuHelpWindow._jtLL_MenuScreenCustomMVPatched) {
                const _refresh = this._menuHelpWindow.refresh;
                this._menuHelpWindow.refresh = function () {
                    return TranslationManager.fetchRawData(() => {
                        return _refresh.apply(this, arguments);
                    })
                };
                this._menuHelpWindow._jtLL_MenuScreenCustomMVPatched = true;
            }
            if (this._menuHelpWindow && this._commandWindow) {
                _helpCommandWindows.add(this._commandWindow);
            }
            return result;
        };
        const _currentName = Window_Command.prototype.currentName;
        Window_Command.prototype.currentName = function () {
            const name = _currentName.apply(this, arguments);
            if (_helpCommandWindows.has(this) && _sourceByTranslatedName.has(name)) {
                return _sourceByTranslatedName.get(name);
            }
            return name;
        };
        Scene_Menu._jtLL_MenuScreenCustomMVPatched = true;
    }

    //LL_MenuScreenStatusMV.js
    //1.0.2
    //MV
    //LL_MenuScreenStatus.js
    //1.0.2
    //MZ
    function patch_LL_MenuScreenStatusMV() {
        if (
            typeof Scene_Status.prototype.createStatusWithPictureWindow !== 'function' ||
            Scene_Status._jtLL_MenuScreenStatusMVPatched
        ) return;
        const _createSWPW = Scene_Status.prototype.createStatusWithPictureWindow;
        Scene_Status.prototype.createStatusWithPictureWindow = function () {
            const result = _createSWPW.apply(this, arguments);
            const _statusWindow = this._statusWithPictureWindow;
            if (_statusWindow && typeof _statusWindow.drawExpInfo === 'function' && !_statusWindow._jtLL_MenuScreenStatusMVPatched) {
                const _drawEI = _statusWindow.drawExpInfo;
                _statusWindow.drawExpInfo = function () {
                    return TranslationManager.skipPluginTrans(() => {
                        return _drawEI.apply(this, arguments);
                    })
                };
                _statusWindow._jtLL_MenuScreenStatusMVPatched = true;
            }
            return result;
        };
        Scene_Status._jtLL_MenuScreenStatusMVPatched = true;
    }

    //LL_GalgeChoiceWindowMV.js
    //2.0.2
    //MV
    function patch_LL_GalgeChoiceWindowMV() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_Message.prototype.setGalgeChoices !== 'function' ||
            Game_Message._jtLL_GalgeChoiceWindowMVPatched
        ) return;
        const _startIpt = Window_Message.prototype.startInput;
        Window_Message.prototype.startInput = function () {
            const _choiceWindow = this._galgeChoiceWindow;
            if (_choiceWindow && gameMessage.isGalgeChoice() && !_choiceWindow._jtLL_GalgeChoiceWindowMVPatched) {
                const _CEC = _choiceWindow.convertEscapeCharacters;
                _choiceWindow.convertEscapeCharacters = function (text) {
                    if (
                        TranslationManager._translationDisableDepth > 0 ||
                        TranslationManager._translatedSkipDepth > 0
                    ) {
                        return _CEC.apply(this, arguments);
                    };
                    const translated = TranslationManager.translate(text);
                    return TranslationManager.skipPluginTrans(() => {
                        return _CEC.call(this, translated);
                    });
                };
                const _drawText = _choiceWindow.drawText;
                _choiceWindow.drawText = function () {
                    return TranslationManager.skipPluginTrans(() => {
                        return _drawText.apply(this, arguments);
                    });
                };
                _choiceWindow._jtLL_GalgeChoiceWindowMVPatched = true;
            };
            return _startIpt.apply(this, arguments);
        };
        Game_Message._jtLL_GalgeChoiceWindowMVPatched = true;
    }

    //LL_GalgeChoiceWindow.js
    //2.0.1
    //MZ
    function patch_LL_GalgeChoiceWindow() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Scene_Message.prototype.createGalgeChoiceListWindow !== 'function' ||
            PluginManager._jtLL_GalgeChoiceWindowPatched
        ) return;
        const _canTranslate = () => !TranslationManager.isRawData() && TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0;
        const commands = PluginManager._commands;
        const key = 'LL_GalgeChoiceWindow:showChoice';
        if (typeof commands[key] !== 'function') return;
        const _showChoice = commands[key];
        commands[key] = function (args) {
            const displayArgs = Object.assign({}, args);
            if (_canTranslate()) {
                displayArgs.messageText = TranslationManager.translate(String(args.messageText));
            }
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _showChoice.call(this, displayArgs);
                })
            })
        };
        const _installWindow = window => {
            if (!window.constructor || window.constructor.name !== 'Window_GalgeChoiceList' || window._jtLL_GalgeChoiceWindowPatched) return;
            //constructor name huh
            const _addC = window.addCommand;
            window.addCommand = function () {
                return TranslationManager.disablePluginTrans(() => _addC.apply(this, arguments));
            };
            const _CEC = window.convertEscapeCharacters;
            window.convertEscapeCharacters = function (text) {
                if (!_canTranslate()) {
                    return _CEC.apply(this, arguments);
                }
                const translated = TranslationManager.translate(text);
                return TranslationManager.skipPluginTrans(() => {
                    return _CEC.call(this, translated);
                });
            };
            const _drawText = window.drawText;
            window.drawText = function () {
                return TranslationManager.skipPluginTrans(() => _drawText.apply(this, arguments));
            };
            const _setQT = window.setQuestionText;
            window.setQuestionText = function () {
                return TranslationManager.skipPluginTrans(() => _setQT.apply(this, arguments));
            };
            window._jtLL_GalgeChoiceWindowPatched = true;
        };
        const _createGCLW = Scene_Message.prototype.createGalgeChoiceListWindow;
        Scene_Message.prototype.createGalgeChoiceListWindow = function () {
            const _initialize = Window_Command.prototype.initialize;
            Window_Command.prototype.initialize = function () {
                _installWindow(this);
                return _initialize.apply(this, arguments);
            };
            try {
                return _createGCLW.apply(this, arguments);
            } finally {
                Window_Command.prototype.initialize = _initialize;
            }
        };
        PluginManager._jtLL_GalgeChoiceWindowPatched = true;
    }

    //VisuMZ_1_BattleCore.js
    //1.90
    //MZ
    function patch_VisuMZ_1_BattleCore() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.BattleCore ||
            VisuMZ._jtVisuMZ_1_BattleCorePatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        if (typeof DataManager.getSkillIdWithName === 'function') {
            DataManager.getSkillIdWithName = wrapRaw(DataManager.getSkillIdWithName);
        }
        if (typeof DataManager.getEnemyIdWithName === 'function') {
            DataManager.getEnemyIdWithName = wrapRaw(DataManager.getEnemyIdWithName);
        }
        if (typeof Window_InBattleStatusStates !== 'undefined' && typeof Window_InBattleStatusStates.prototype.includeState === 'function') {
            Window_InBattleStatusStates.prototype.includeState = wrapRaw(Window_InBattleStatusStates.prototype.includeState);
        }
        VisuMZ._jtVisuMZ_1_BattleCorePatched = true;
    }

    //VisuMZ_1_ItemsEquipsCore.js
    //1.61
    //MZ
    function patch_VisuMZ_1_ItemsEquipsCore() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.ItemsEquipsCore ||
            VisuMZ._jtVisuMZ_1_ItemsEquipsCorePatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        [
            'getSkillIdWithName',
            'getItemIdWithName',
            'getWeaponIdWithName',
            'getArmorIdWithName'
        ].forEach(function (method) {
            if (typeof DataManager[method] === 'function') {
                DataManager[method] = wrapRaw(DataManager[method]);
            }
        });
        if (typeof VisuMZ.ItemsEquipsCore.IncludeShopItem === 'function') {
            VisuMZ.ItemsEquipsCore.IncludeShopItem = wrapRaw(VisuMZ.ItemsEquipsCore.IncludeShopItem);
        }
        if (typeof Window_ItemList.prototype.sortListItemScene === 'function') {
            Window_ItemList.prototype.sortListItemScene = wrapRaw(Window_ItemList.prototype.sortListItemScene);
        }
        VisuMZ._jtVisuMZ_1_ItemsEquipsCorePatched = true;
    }

    //VisuMZ_1_SkillsStatesCore.js
    //1.58
    //MZ
    function patch_VisuMZ_1_SkillsStatesCore() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.SkillsStatesCore ||
            VisuMZ._jtVisuMZ_1_SkillsStatesCorePatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        ['getSkillIdWithName', 'getStateIdWithName'].forEach(function (method) {
            if (typeof DataManager[method] === 'function') {
                DataManager[method] = wrapRaw(DataManager[method]);
            }
        });
        if (typeof Window_SkillList.prototype.sortSkillList === 'function') {
            Window_SkillList.prototype.sortSkillList = wrapRaw(Window_SkillList.prototype.sortSkillList);
        };
        VisuMZ.SkillsStatesCore.Settings.Costs.forEach(function (settings) {
            if (typeof settings.CalcJS === 'function') {
                settings.CalcJS = wrapRaw(settings.CalcJS);
            }
        });
        VisuMZ._jtVisuMZ_1_SkillsStatesCorePatched = true;
    }

    //VisuMZ_1_OptionsCore.js
    //1.28
    //MZ
    function patch_VisuMZ_1_OptionsCore() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.OptionsCore ||
            typeof Window_OptionsCategory === 'undefined' ||
            VisuMZ._jtVisuMZ_1_OptionsCorePatched
        ) return;
        const _rawNames = new WeakMap();
        const _addC = Window_OptionsCategory.prototype.addCommand;
        Window_OptionsCategory.prototype.addCommand = function () {
            const length = this._list.length;
            const result = TranslationManager.disablePluginTrans(() => _addC.apply(this, arguments));
            if (this._list.length > length) {
                const command = this._list[this._list.length - 1];
                const rawName = command.name;
                if (TranslationManager._translationDisableDepth === 0) {
                    command.name = TranslationManager.translate(rawName);
                }
                _rawNames.set(command, { rawName: rawName, displayName: command.name });
            }
            return result;
        };
        const _setC = Window_Options.prototype.setCategory;
        Window_Options.prototype.setCategory = function (command) {
            const names = command && _rawNames.get(command);
            if (!names || command.name !== names.displayName) {
                return _setC.apply(this, arguments);
            }
            const _rawCmd = Object.create(command);
            _rawCmd.name = names.rawName;
            return _setC.call(this, _rawCmd);
        };
        VisuMZ._jtVisuMZ_1_OptionsCorePatched = true;
    }

    //VisuMZ_1_MessageCore.js
    //1.57
    //MZ
    //breaks CEC in Window_Base
    function patch_VisuMZ_1_MessageCore() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.MessageCore ||
            VisuMZ._jtVisuMZ_1_MessageCorePatched
        ) return;
        var frame = null;
        var colorCache = new WeakMap();
        var wordWrapDepth = 0;
        function _canTranslate() {
            return TranslationManager.isInitialized() && !TranslationManager.isRawData() && TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0;
        };
        function _outputEnabled(window) {
            return frame && frame.window === window ? frame.translate : _canTranslate();
        };
        function _protectedRanges(text, includeCodes) {
            var ranges = [];
            function collect(regexp) {
                var match;
                while ((match = regexp.exec(text))) {
                    ranges.push([match.index, match.index + match[0].length]);
                    if (!match[0].length) regexp.lastIndex++;
                }
            };
            collect(/(?:\\|\x1b)(?:KEY|TL|TRANSLATE|LOC|LOCALIZE|LOCALE)(?:\[[^\]]*\]|<[^>]*>|\{[^}]*\})|<[^>]*>|\$(?:\[[^\]]*\]|<[^>]*>|\{[^}]*\})/gi);
            if (includeCodes) { collect(/(?:\\|\x1b)[A-Z]+(?:\[[^\]]*\])?/gi); };
            var macros = VisuMZ.MessageCore.Settings.TextMacros;
            for (var i = 0; i < macros.length; i++) {
                collect(new RegExp('\\[' + macros[i].Match + '\\]', 'gi'));
            }
            return ranges;
        };
        const _translate = TranslationManager.translate;
        TranslationManager.translate = function (text, spaces, times, cache, mask) {
            if (typeof text === 'string') {
                const ownMask = _protectedRanges(text);
                if (ownMask.length) {
                    const args = Array.prototype.slice.call(arguments);
                    args[4] = (Array.isArray(mask) ? mask : []).concat(ownMask);
                    return _translate.apply(this, args);
                }
            }
            return _translate.apply(this, arguments);
        };
        function _wrapConversion(target, name) {
            const ori = target[name];
            if (typeof ori !== 'function') return;
            target[name] = function () {
                const previous = frame;
                frame = { window: this, translate: _canTranslate() };
                try {
                    return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => ori.apply(this, arguments)));
                } finally {
                    frame = previous;
                }
            };
        };
        _wrapConversion(Window_Base.prototype, 'convertEscapeCharacters');
        _wrapConversion(Window_Message.prototype, 'convertNewPageTextStateMacros');
        const _convertTM = Window_Base.prototype.convertTextMacros;
        Window_Base.prototype.convertTextMacros = function () {
            return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => _convertTM.apply(this, arguments)));
        };
        [Window_Base.prototype, Window_Message.prototype].forEach(function (target) {
            const _prepareWWEC = target.prepareWordWrapEscapeCharacters;
            target.prepareWordWrapEscapeCharacters = function (text) {
                const enabled = wordWrapDepth === 0 && _outputEnabled(this);
                if (enabled) arguments[0] = TranslationManager.translate(text);
                wordWrapDepth++;
                var result;
                try {
                    result = _prepareWWEC.apply(this, arguments);
                } finally {
                    wordWrapDepth--;
                }
                if (enabled) TranslationManager.pushConvertedText(result);
                return result;
            };
        });
        function _translatedColors(list) {
            const cached = colorCache.get(list);
            if (cached && cached.dictionary === TranslationManager._dict) {
                return cached.entries;
            }
            const entries = [];
            for (var i = 0; i < list.length; i++) {
                const match = /^\x1bC\[(\d+)\]([\s\S]*)\x1bPREVCOLOR\[0\]$/.exec(list[i][1]);
                if (!match) continue;
                const word = TranslationManager.translate(match[2]);
                if (!word || word === match[2]) continue;
                let source = VisuMZ.MessageCore.ConvertTextAutoColorRegExpFriendly(word);
                if (list[i][0].source.slice(0, 2) === '\\b' && !/[\u3000-\u303f\u3040-\u30ff\uff00-\uffef\u4e00-\u9faf\u2605-\u2606\u2190-\u2195\u203b]/.test(word)) {
                    source = '\\b' + source + '\\b';
                }
                entries.push([
                    new RegExp(source, (list[i][0].global ? 'g' : '') + (list[i][0].ignoreCase ? 'i' : '')),
                    '\x1bC[' + match[1] + ']' + word + '\x1bPREVCOLOR[0]'
                ]);
            }
            colorCache.set(list, {
                dictionary: TranslationManager._dict,
                entries: entries
            });
            return entries;
        };
        function _applyTranslatedColors(text, list) {
            const entries = _translatedColors(list);
            for (var i = 0; i < entries.length; i++) {
                const ranges = _protectedRanges(text, true);
                const replacement = entries[i][1];
                text = text.replace(entries[i][0], function (match, offset) {
                    for (var j = 0; j < ranges.length; j++) {
                        if (offset < ranges[j][1] && offset + match.length > ranges[j][0]) {
                            return match;
                        }
                    }
                    return replacement;
                });
            }
            return text;
        };
        const _processSACC = Window_Base.prototype.processStoredAutoColorChanges;
        Window_Base.prototype.processStoredAutoColorChanges = function (text) {
            const result = _processSACC.apply(this, arguments);
            return _outputEnabled(this) ? _applyTranslatedColors(result, VisuMZ.MessageCore.AutoColorRegExp) : result;
        };
        const _processANACC = Window_Base.prototype.processActorNameAutoColorChanges;
        Window_Base.prototype.processActorNameAutoColorChanges = function (text) {
            const result = _processANACC.apply(this, arguments);
            return _outputEnabled(this) ? _applyTranslatedColors(result, this._autoColorActorNames) : result;
        };
        ['Bitmap_drawText', 'Bitmap_measureTextWidth'].forEach(function (name) {
            const ori = VisuMZ.MessageCore[name];
            if (typeof ori !== 'function') return;
            VisuMZ.MessageCore[name] = function (text) {
                if (_canTranslate()) arguments[0] = TranslationManager.translate(text);
                return ori.apply(this, arguments);
            };
        });
        const _command = TextManager.command;
        TextManager.command = function () {
            if (TextManager.isVisuMzLocalizationEnabled()) {
                return TranslationManager.fetchRawData(() => _command.apply(this, arguments));
            }
            return _command.apply(this, arguments);
        };
        VisuMZ._jtVisuMZ_1_MessageCorePatched = true;
    }

    //VisuMZ_3_SkillCooldowns.js
    //1.03
    //MZ
    function patch_VisuMZ_3_SkillCooldowns() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.SkillCooldowns ||
            VisuMZ._jtVisuMZ_3_SkillCooldownsPatched
        ) return;
        [
            'isBypassCooldowns',
            'isBypassWarmups',
            'applyCDWUnotetagsFlat',
            'applyCDWUnotetagsRate'
        ].forEach(function (method) {
            const ori = Game_BattlerBase.prototype[method];
            if (typeof ori !== 'function') return;
            Game_BattlerBase.prototype[method] = function () {
                return TranslationManager.fetchRawData(() => {
                    return ori.apply(this, arguments);
                });
            };
        });
        VisuMZ._jtVisuMZ_3_SkillCooldownsPatched = true;
    }

    //VisuMZ_3_EnemyLevels.js
    //1.05
    //MZ
    function patch_VisuMZ_3_EnemyLevels() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.EnemyLevel ||
            typeof Game_Enemy.prototype.meetsSkillConditionsEnemyLevel !== 'function' ||
            VisuMZ._jtVisuMZ_3_EnemyLevelsPatched
        ) return;
        const _meetsSCEL = Game_Enemy.prototype.meetsSkillConditionsEnemyLevel;
        Game_Enemy.prototype.meetsSkillConditionsEnemyLevel = function () {
            return TranslationManager.fetchRawData(() => {
                return _meetsSCEL.apply(this, arguments);
            })
        };
        VisuMZ._jtVisuMZ_3_EnemyLevelsPatched = true;
    }

    //VisuMZ_4_DiceRollsRngSeeds.js
    //1.00
    //MZ
    function patch_VisuMZ_4_DiceRollsRngSeeds() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.DiceRollsRngSeeds ||
            typeof Game_Action.prototype.applyRngAspects !== 'function' ||
            Game_Action._jtVisuMZ_4_DiceRollsRngSeedsPatched
        ) return;
        const _applyRA = Game_Action.prototype.applyRngAspects;
        Game_Action.prototype.applyRngAspects = function () {
            return TranslationManager.fetchRawData(() => _applyRA.apply(this, arguments));
        };
        Game_Action._jtVisuMZ_4_DiceRollsRngSeedsPatched = true;
    }

    //VisuMZ_4_CombatLog.js
    //1.08
    //MZ
    function patch_VisuMZ_4_CombatLog() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof VisuMZ === 'undefined' ||
            !VisuMZ.CombatLog ||
            typeof Window_CombatLogDisplay === 'undefined' ||
            VisuMZ._jtVisuMZ_4_CombatLogPatched
        ) return;
        const separator = '=====HORZLINE=====';
        const _addC = Window_CombatLogDisplay.prototype.addCommand;
        Window_CombatLogDisplay.prototype.addCommand = function (name) {
            if (name !== separator) return _addC.apply(this, arguments);
            return TranslationManager.disablePluginTrans(() => _addC.apply(this, arguments));
        };
        VisuMZ._jtVisuMZ_4_CombatLogPatched = true;
    }

    //VisuMZ_2_ItemCraftingSys.js
    //1.20
    //MZ
    function patch_VisuMZ_2_ItemCraftingSys() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof VisuMZ === "undefined" ||
            !VisuMZ.ItemCraftingSys ||
            typeof VisuMZ.ItemCraftingSys.maskItemName !== "function" ||
            typeof Window_ItemCraftingIngredient === "undefined" ||
            VisuMZ._jtVisuMZ_2_ItemCraftingSysPatched
        ) return;
        const _maskIN = VisuMZ.ItemCraftingSys.maskItemName;
        VisuMZ.ItemCraftingSys.maskItemName = function () {
            return TranslationManager.fetchRawData(() => _maskIN.apply(this, arguments));
        };
        if (typeof Window_ItemCraftingIngredient.prototype.drawText === 'function') {
            const _drawText = Window_ItemCraftingIngredient.prototype.drawText;
            Window_ItemCraftingIngredient.prototype.drawText = function (text, x, y, maxWidth, align) {
                if (
                    !this._alreadySelected ||
                    TranslationManager.isRawData() ||
                    TranslationManager._translationDisableDepth > 0 ||
                    TranslationManager._translatedSkipDepth > 0
                ) return _drawText.apply(this, arguments);
                const settings = VisuMZ.ItemCraftingSys.Settings.General;
                this.contents.textColor = ColorManager.getColor(settings.SelectedColor);
                text = TranslationManager.translate(text) + TranslationManager.translate(settings.SelectedText);
                return TranslationManager.skipPluginTrans(() => Window_Base.prototype.drawText.call(this, text, x, y, maxWidth, align));
            };
        }
        VisuMZ._jtVisuMZ_2_ItemCraftingSysPatched = true;
    }

    //GALV_VisualNovelChoices.js
    //1.6
    //MV
    //1.0
    //MZ
    function patch_GALV_VisualNovelChoices() {
        if (
            typeof Galv === 'undefined' || !Galv.VNC ||
            typeof Window_ChoiceList.prototype.setupVNChoices !== 'function' ||
            Galv._jtGALV_VisualNovelChoicesPatched
        ) return;
        const _CEC = Window_ChoiceList.prototype.convertEscapeCharacters;
        Window_ChoiceList.prototype.convertEscapeCharacters = function (text) {
            if (typeof text !== 'string' || TranslationManager.isRawData() || TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) {
                return _CEC.apply(this, arguments);
            }
            arguments[0] = TranslationManager.translate(text);
            const converted = TranslationManager.skipPluginTrans(() => _CEC.apply(this, arguments));
            TranslationManager.pushConvertedText(converted);
            return converted;
        };
        let measureDepth = 0;
        const _itemRFT = Window_ChoiceList.prototype.itemRectForText;
        Window_ChoiceList.prototype.itemRectForText = function () {
            if (!$gameSystem.vnChoices) return _itemRFT.apply(this, arguments);
            measureDepth++;
            try {
                return _itemRFT.apply(this, arguments);
            } finally {
                measureDepth--;
            }
        };
        const _textWidth = Window_ChoiceList.prototype.textWidth;
        Window_ChoiceList.prototype.textWidth = function () {
            if (measureDepth === 0) return _textWidth.apply(this, arguments);
            return TranslationManager.skipPluginTrans(() => _textWidth.apply(this, arguments));
        };
        Galv._jtGALV_VisualNovelChoicesPatched = true;
    }

    //Galv_MapTravel.js
    //1.2
    //MV
    //1.1
    //MZ
    //might not be optimal translating before | splitting
    function patch_Galv_MapTravel() {
        if (
            typeof Galv === 'undefined' ||
            !Galv.MAPT ||
            typeof Window_MapTravelLocation === 'undefined' ||
            typeof Window_MapTravelLocation.prototype.refresh !== 'function' ||
            Galv._jtGalv_MapTravelPatched
        ) return;
        const _refresh = Window_MapTravelLocation.prototype.refresh;
        Window_MapTravelLocation.prototype.refresh = function () {
            if (TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) {
                return _refresh.apply(this, arguments);
            }
            this.contents.clear();
            if (Galv.MAPT.active) {
                const desc = TranslationManager.translate(this.data().desc);
                const lines = desc.split('|');
                TranslationManager.skipPluginTrans(() => {
                    for (let i = 0; i < lines.length; i++) {
                        this.drawTextEx(lines[i], this.textPadding(), this.lineHeight() * i);
                    }
                });
                this._currentLocation = Galv.MAPT.active;
            }
        };
        Galv._jtGalv_MapTravelPatched = true;
    }

    //GALV_MessageBusts.js
    //2.8
    //MV
    //not rlly necessary, but no idea how mtool process \BST[]
    //maybe check dict when installing?
    function patch_GALV_MessageBusts() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Imported === 'undefined' ||
            !Imported.Galv_MessageBusts ||
            typeof Window_Message.prototype.obtainSpecialParam !== 'function' ||
            Window_Message._jtGALV_MessageBustsPatched
        ) return;
        let _bustMaskDepth = 0;
        function _collectBustMasks(text) {
            const masks = [];
            const prefixes = /[\\\x1b]+/g;
            let prefix;
            while ((prefix = prefixes.exec(text))) {
                if (prefix[0].length % 2 === 0) continue;
                const param = /^BST\[(.*)]/i.exec(text.slice(prefixes.lastIndex));
                if (!param) continue;
                const end = prefixes.lastIndex + param[0].length;
                masks.push([prefixes.lastIndex - 1, end]);
                prefixes.lastIndex = end;
            }
            return masks;
        };
        const _translate = TranslationManager.translate;
        TranslationManager.translate = function (text, detectStartWhitespace, times, cache, mask) {
            if (_bustMaskDepth > 0 && typeof text === 'string') {
                const ranges = _collectBustMasks(text);
                if (ranges.length > 0) {
                    return _translate.call(
                        this, text, detectStartWhitespace, times, cache,
                        (Array.isArray(mask) ? mask : []).concat(ranges)
                    );
                }
            }
            return _translate.apply(this, arguments);
        };
        const _CEC = Window_Message.prototype.convertEscapeCharacters;
        Window_Message.prototype.convertEscapeCharacters = function () {
            _bustMaskDepth++;
            try {
                return _CEC.apply(this, arguments);
            } finally {
                _bustMaskDepth--;
            }
        };
        Window_Message._jtGALV_MessageBustsPatched = true;
    }

    //GALV_MessageBustsMZ.js
    //1.2
    //MZ
    //little diff from MV
    function patch_GALV_MessageBustsMZ() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof Imported === "undefined" ||
            !Imported.Galv_MessageBusts ||
            typeof Window_Message.prototype.obtainBustParam !== "function" ||
            Window_Message._jtGALV_MessageBustsMZPatched
        ) return;
        const _CECR = _Window_Base_convertEscapeCharacters;
        const _CEC = Window_Message.prototype.convertEscapeCharacters;
        Window_Message.prototype.convertEscapeCharacters = function () {
            const _rawText = TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => _CECR.apply(this, arguments)));
            const _rawCmd = _rawText.match(/\x1bBST\[[^\]]*\]/gi) || [];
            const _displayText = _CEC.apply(this, arguments);
            if (!_rawCmd.length) return _displayText; //no BST in text
            let index = 0;
            const result = _displayText.replace(/\x1bBST\[[^\]]*\]/gi, command => _rawCmd[index++] || command);
            if (result !== _displayText) TranslationManager.pushConvertedText(result);
            return result;
        };
        Window_Message._jtGALV_MessageBustsMZPatched = true;
    }

    //EST_PHONE_MENU_MZ.js
    //1.1
    //MZ
    function patch_EST_PHONE_MENU_MZ() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof EST === 'undefined' || !EST.PhoneMenu ||
            typeof Window_PhoneCommand === 'undefined' ||
            typeof Scene_Phone === 'undefined' ||
            Game_System._jtEST_PHONE_MENU_MZPatched
        ) return;
        [
            [Game_System.prototype, 'fullPhoneMenu'],
            [Window_PhoneCommand.prototype, 'addMainCommands'],
            [Scene_Phone.prototype, 'onPhoneMenuOk']
        ].forEach(target => {
            const ori = target[0][target[1]];
            if (typeof ori === 'function') {
                target[0][target[1]] = function () {
                    return TranslationManager.fetchRawData(() => ori.apply(this, arguments));
                }
            }
        });
        Game_System._jtEST_PHONE_MENU_MZPatched = true;
    }

    //EST_PHONE_ADDON_BASICMENU.js
    //1.2
    //MZ
    function patch_EST_PHONE_ADDON_BASICMENU() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof EST === 'undefined' || !EST.PhoneMenu ||
            typeof Window_PhoneHelp === 'undefined' ||
            typeof Window_PhoneAddonStatus === 'undefined' ||
            Window_PhoneHelp._jtEST_PHONE_ADDON_BASICMENUPatched
        ) return;
        function _wrapSplitDrawText(prototype, method) {
            const ori = prototype[method];
            if (typeof ori !== 'function') return;
            prototype[method] = function () {
                const _descriptor = Object.getOwnPropertyDescriptor(this, 'drawText');
                const _drawT = this.drawText;
                this.drawText = function () {
                    return TranslationManager.skipPluginTrans(() => _drawT.apply(this, arguments));
                };
                try {
                    return ori.apply(this, arguments);
                } finally {
                    if (_descriptor) {
                        Object.defineProperty(this, 'drawText', _descriptor);
                    }
                    else {
                        delete this.drawText;
                    }
                };
            }
        };
        _wrapSplitDrawText(Window_PhoneHelp.prototype, 'refresh');
        _wrapSplitDrawText(Window_PhoneAddonStatus.prototype, 'drawActorProfile');
        [
            [Window_PhoneAddonSelection.prototype, 'drawItem'],
            [Window_PhoneAddonStatus.prototype, 'drawExpGauge']
        ].forEach(target => {
            const ori = target[0][target[1]];
            if (typeof ori !== 'function') return;
            target[0][target[1]] = function () {
                return TranslationManager.fetchRawData(() => ori.apply(this, arguments));
            };
        });
        const _drawTitle = Window_PhoneAddonSave.prototype.drawTitle;
        if (typeof _drawTitle === 'function') {
            Window_PhoneAddonSave.prototype.drawTitle = function () {
                return TranslationManager.skipPluginTrans(() => _drawTitle.apply(this, arguments));
            }
        }
        Window_PhoneHelp._jtEST_PHONE_ADDON_BASICMENUPatched = true;
    }

    //EST_PRICE_FORMULA_MZ.js
    //1.0
    //MZ
    function patch_EST_PRICE_FORMULA_MZ() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof EST === 'undefined' ||
            !EST.PriceFormulaMZ ||
            typeof EST.PriceFormulaMZ.Window_ShopBuy_price !== 'function' ||
            typeof EST.PriceFormulaMZ.Scene_Shop_sellingPrice !== 'function' ||
            EST._jtEST_PRICE_FORMULA_MZPatched
        ) return;
        [
            [Window_ShopBuy.prototype, 'price'],
            [Scene_Shop.prototype, 'sellingPrice']
        ].forEach(target => {
            const ori = target[0][target[1]];
            target[0][target[1]] = function () {
                return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => ori.apply(this, arguments)));
            };
        });
        EST._jtEST_PRICE_FORMULA_MZPatched = true;
    }

    //NRP_BattleTargetCursor.js
    //1.05
    //MV/MZ
    function patch_NRP_BattleTargetCursor() {
        if (
            typeof Window_BattleEnemyName === 'undefined' ||
            typeof Window_BattleActorName === 'undefined' ||
            Window_BattleActorName._jtNRP_BattleTargetCursorPatched
        ) return;
        [
            Window_BattleEnemyName.prototype,
            Window_BattleActorName.prototype
        ].forEach(prototype => {
            ['showTargetName', 'drawItem'].forEach(method => {
                const ori = prototype[method];
                if (typeof ori !== 'function') return;
                prototype[method] = function () {
                    return TranslationManager.fetchRawData(() => ori.apply(this, arguments));
                };
            });
            const _CEC = prototype.convertEscapeCharacters;
            prototype.convertEscapeCharacters = function () {
                return TranslationManager.fetchTranslatedData(() => {
                    const result = _CEC.apply(this, arguments);
                    if (TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0) {
                        TranslationManager.pushConvertedText(result);
                    }
                    return result;
                });
            };
        });
        Window_BattleActorName._jtNRP_BattleTargetCursorPatched = true;
    }

    //NRP_CallEnemy.js
    //1.06
    //MV/MZ
    function patch_NRP_CallEnemy() {
        if (
            typeof Game_Action.prototype.callEnemy !== 'function' ||
            typeof Window_BattleLog.prototype.displayCallEnemy !== 'function' ||
            Game_Action._jtNRP_CallEnemyPatched
        ) return;
        const _makeUN = Game_Troop.prototype.makeUniqueNames;
        Game_Troop.prototype.makeUniqueNames = function () {
            return TranslationManager.fetchRawData(() => _makeUN.apply(this, arguments));
        };
        const _displayCE = Window_BattleLog.prototype.displayCallEnemy;
        Window_BattleLog.prototype.displayCallEnemy = function () {
            return TranslationManager.fetchRawData(() => _displayCE.apply(this, arguments));
        };
        Game_Action._jtNRP_CallEnemyPatched = true;
    }

    //NRP_CombinationSkill.js
    //1.40
    //MV/MZ
    //maybe remove the text change detection in CEC override?
    function patch_NRP_CombinationSkill() {
        if (
            typeof Game_Action.prototype.setCsMembers !== 'function' ||
            typeof Game_Action.prototype.csMembers !== 'function' ||
            Game_Action._jtNRP_CombinationSkillPatched
        ) return;
        const _displayA = Window_BattleLog.prototype.displayAction;
        Window_BattleLog.prototype.displayAction = function (subject, item) {
            if (item && item.meta && (item.meta.CS_Actors || item.meta.CS_Battlers || item.meta.CS_Enemys)) {
                return TranslationManager.fetchRawData(() => _displayA.apply(this, arguments));
            }
            return _displayA.apply(this, arguments);
        };
        if (Utils.RPGMAKER_NAME === 'MV') {
            const _CEC = Window_BattleLog.prototype.convertEscapeCharacters;
            Window_BattleLog.prototype.convertEscapeCharacters = function () {
                const text = _CEC.apply(this, arguments);
                if (!TranslationManager.isRawData() && TranslationManager._translationDisableDepth === 0) {
                    TranslationManager.pushConvertedText(text);
                }
                return text;
            };
        }
        Game_Action._jtNRP_CombinationSkillPatched = true;
    }

    //NRP_ChargeSkill.js
    //1.05
    //MV/MZ
    function patch_NRP_ChargeSkill() {
        if (
            typeof Game_BattlerBase.prototype.updateChargeStateTurns !== 'function' ||
            Game_BattlerBase._jtNRP_ChargeSkillPatched
        ) return;
        const _startA = BattleManager.startAction;
        BattleManager.startAction = function () {
            const subject = this._subject;
            const action = subject && subject.currentAction();
            const item = action && action.item();
            if (!item || !item.meta || !item.meta.ChargeState) return _startA.apply(this, arguments);
            return TranslationManager.fetchRawData(() => _startA.apply(this, arguments));
        };
        const _displayA = Window_BattleLog.prototype.displayAction;
        Window_BattleLog.prototype.displayAction = function (subject, item) {
            const chargeSkills = subject && subject._chargeSkills;
            const hasChargeState = chargeSkills && subject._states.some(stateId => !!chargeSkills[stateId]);
            if (!hasChargeState && !(item && item.meta && item.meta.ChargeState)) return _displayA.apply(this, arguments);
            return TranslationManager.fetchRawData(() => _displayA.apply(this, arguments));
        };
        Game_BattlerBase._jtNRP_ChargeSkillPatched = true;
    }

    //NRP_Substitute.js
    //1.03
    //MV
    function patch_NRP_Substitute() {
        if (
            typeof Game_Battler.prototype.getSubstituteData !== 'function' ||
            typeof Game_Action.prototype.makeSubstituteTargets !== 'function' ||
            Game_Action._jtNRP_SubstitutePatched
        ) return;
        const _getSD = Game_Battler.prototype.getSubstituteData;
        Game_Battler.prototype.getSubstituteData = function () {
            return TranslationManager.fetchRawData(() => _getSD, apply(this, arguments));
        };
        Game_Action._jtNRP_SubstitutePatched = true;
    }

    //NRP_OriginalRewards.js
    //1.00
    //MV/MZ
    //Wordwrap combination in MZ left unhandled
    function patch_NRP_OriginalRewards() {
        if (
            typeof Game_Enemy.prototype.customReward !== "function" ||
            Game_Enemy._jtNRP_OriginalRewardsPatched
        ) return;
        const _customC = Game_Enemy.prototype.customReward;
        Game_Enemy.prototype.customReward = function () {
            return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => _customC.apply(this, arguments)));
        };
        Game_Enemy._jtNRP_OriginalRewardsPatched = true;
    }

    //NRP_U_SkillTreeReserve.js
    //1.001
    //MV
    function patch_NRP_U_SkillTreeReserve() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof SkillTreeClassAlias === 'undefined' ||
            !SkillTreeClassAlias.Scene_SkillTree ||
            typeof SkillTreeClassAlias.Scene_SkillTree.prototype.createNodeOpenReserveWindow !== 'function' ||
            typeof Game_Actor.prototype.gainSp !== 'function' ||
            SkillTreeClassAlias._jtNRP_U_SkillTreeReservePatched
        ) return;
        const _createNORW = SkillTreeClassAlias.Scene_SkillTree.prototype.createNodeOpenReserveWindow;
        SkillTreeClassAlias.Scene_SkillTree.prototype.createNodeOpenReserveWindow = function () {
            const result = TranslationManager.fetchRawData(() => _createNORW.apply(this, arguments));
            const _reserveWindow = this._windowNodeOpenReserve;
            const _refresh = _reserveWindow.refresh;
            _reserveWindow.refresh = function () {
                return TranslationManager.fetchRawData(() => _refresh.apply(this, arguments));
            };
            return result;
        };
        const _gainSp = Game_Actor.prototype.gainSp;
        Game_Actor.prototype.gainSp = function () {
            return TranslationManager.fetchRawData(() => _gainSp.apply(this, arguments));
        };
        SkillTreeClassAlias._jtNRP_U_SkillTreeReservePatched = true;
    }

    //NRP_WindowBattleLogLayout.js
    //1.05
    //MV/MZ
    function patch_NRP_WindowBattleLogLayout() {
        if (
            typeof Window_BattleLog.prototype.getBack !== 'function' ||
            typeof Window_BattleLog.prototype.startGradientSize !== 'function' ||
            typeof Window_BattleLog.prototype.endGradientSize !== 'function' ||
            Window_BattleLog._jtNRP_WindowBattleLogLayoutPatched
        ) return;
        const _CEC = Window_BattleLog.prototype.convertEscapeCharacters;
        Window_BattleLog.prototype.convertEscapeCharacters = function () {
            const result = _CEC.apply(this, arguments);
            if (!TranslationManager.isRawData() && TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0) {
                TranslationManager.pushConvertedText(result);
            }
            return result;
        };
        if (Utils.RPGMAKER_NAME === 'MZ') {
            if (
                PluginManager._scripts.indexOf('SimpleMsgSideViewMZ') >= 0 &&
                typeof Window_BattleLog.prototype.addItemNameText === 'function' &&
                typeof Window_BattleLog.prototype.addItemInfoText === 'function'
            ) {
                const _refresh = Window_BattleLog.prototype.refresh;
                Window_BattleLog.prototype.refresh = function () {
                    if (TranslationManager.isRawData() || TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) {
                        return _refresh.apply(this, arguments);
                    }
                    for (let i = 0; i < this._lines.length; i++) {
                        const text = this._lines[i];
                        if (typeof text !== 'string') continue;
                        const marker = text.charAt(0) === '\x1f' ? '\x1f' : '';
                        this._lines[i] = marker + TranslationManager.translate(marker ? text.slice(1) : text);
                    }
                    return TranslationManager.skipPluginTrans(() => _refresh.apply(this, arguments));
                };
                const _drawLT = Window_BattleLog.prototype.drawLineText;
                Window_BattleLog.prototype.drawLineText = function () {
                    return TranslationManager.skipPluginTrans(() => _drawLT.apply(this, arguments));
                };
            } else {
                const _displayA = Window_BattleLog.prototype.displayAction;
                Window_BattleLog.prototype.displayAction = function () {
                    return TranslationManager.fetchRawData(() => _displayA.apply(this, arguments));
                };
            }
        }
        Window_BattleLog._jtNRP_WindowBattleLogLayoutPatched = true;
    }

    //NRP_MessagePicture.js
    //1.10
    //MZ
    function patch_NRP_MessagePicture() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Screen.prototype.showMessagePicture !== 'function' ||
            Game_Screen._jtNRP_MessagePicturePatched
        ) return;
        const _cmd101 = Game_Interpreter.prototype.command101;
        Game_Interpreter.prototype.command101 = function () {
            return TranslationManager.fetchRawData(() => _cmd101.apply(this, arguments));
        };//wont hurt much ig
        const param = PluginManager.parameters('NRP_MessagePicture');
        if ((param.ShowAboveWindow !== 'true' &&
            param.ShowAboveWindow !== true) ||
            !Number(param.LimitMessageWidth)) {
            Game_Screen._jtNRP_MessagePicturePatched = true;
            return;
        }
        let _measuringBitmap = null;
        const _startMsg = Window_Message.prototype.startMessage;
        Window_Message.prototype.startMessage = function () {
            const _previousBitmap = _measuringBitmap;
            _measuringBitmap = this.contents;
            try {
                return _startMsg.apply(this, arguments);
            } finally {
                _measuringBitmap = _previousBitmap;
            }
        };
        const _measureTW = Bitmap.prototype.measureTextWidth;
        Bitmap.prototype.measureTextWidth = function () {
            if (this === _measuringBitmap) {
                return TranslationManager.skipPluginTrans(() => _measureTW.apply(this, arguments));
            }
            return _measureTW.apply(this, arguments);
        };
        Game_Screen._jtNRP_MessagePicturePatched = true;
    }

    //NRP_EvalPluginCommand.js
    //1.031
    //MV/MZ
    //need ignoreDoubleBackslash=false
    function patch_NRP_EvalPluginCommand() {
        if (
            !PluginManager._scripts.some(name => String(name).toLowerCase() === "nrp_evalplugincommand") ||
            Game_Interpreter._jtNRP_EvalPluginCommandPatched
        ) return;
        let frame = null;
        function _wrapConversion(original, kind) {
            return function () {
                const _prevFrame = frame;
                const _currentFrame = {
                    interpreter: this, kind: kind,
                    active: true, released: false
                };
                frame = _currentFrame;
                try {
                    return TranslationManager.fetchRawData(() => {
                        try { return original.apply(this, arguments); }
                        finally {
                            if (_currentFrame.released) TranslationManager._rawDataDepth++;
                        }
                    });
                } finally {
                    frame = _prevFrame;
                }
            }
        };
        function _dispatch(original, receiver, args, kind, interpreter) {
            const _currentFrame = frame;
            if (_currentFrame && _currentFrame.active && _currentFrame.kind === kind && _currentFrame.interpreter === interpreter) {
                _currentFrame.active = false;
                if (TranslationManager._rawDataDepth > 0) {
                    TranslationManager._rawDataDepth--;
                    _currentFrame.released = true;
                }
            }
            return original.apply(receiver, args);
        };
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function () {
            return _dispatch(_pluginC, this, arguments, 356, this);
        };
        Game_Interpreter.prototype.command356 = _wrapConversion(Game_Interpreter.prototype.command356, 356);
        if (Utils.RPGMAKER_NAME === 'MZ') {
            const _callC = PluginManager.callCommand;
            PluginManager.callCommand = function (interpreter) {
                return _dispatch(_callC, this, arguments, 357, interpreter);
            };
            Game_Interpreter.prototype.command357 = _wrapConversion(Game_Interpreter.prototype.command357, 357);
        }
        Game_Interpreter._jtNRP_EvalPluginCommandPatched = true;
    }

    //NRP_GetItemCommon.js
    //1.021
    //MZ
    function patch_NRP_GetItemCommon() {
        if (
            typeof Game_Party.prototype.havedItem !== "function" ||
            typeof Game_Party.prototype.clearHavedItems !== 'function' ||
            Game_Party._jtNRP_GetItemCommonPatched
        ) return;
        const _gainItem = Game_Party.prototype.gainItem;
        Game_Party.prototype.gainItem = function () {
            return TranslationManager.fetchRawData(() => _gainItem.apply(this, arguments));
        };
        Game_Party._jtNRP_GetItemCommonPatched = true;
    }

    //NRP_PictureToFace.js
    //1.01
    //MZ/MV
    function patch_NRP_PictureToFace() {
        if (
            !PluginManager._scripts.some(name => String(name).toLowerCase() === "nrp_picturetoface") ||
            ImageManager._jtNRP_PictureToFacePatched
        ) return;
        const wrapLogic = function (original) {
            return function () {
                return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => original.apply(this, arguments)));
            }
        };
        ImageManager.loadFace = wrapLogic(ImageManager.loadFace);
        Game_Actor.prototype.faceIndex = wrapLogic(Game_Actor.prototype.faceIndex);
        Game_Message.prototype.faceIndex = wrapLogic(Game_Message.prototype.faceIndex);
        ImageManager._jtNRP_PictureToFacePatched = true;
    }

    //NRP_PlayRecord.js
    //1.04
    //MZ
    function patch_NRP_PlayRecord() {
        if (
            Utils.RPGMAKER_NAME !== "MZ" ||
            typeof Scene_PlayRecord === "undefined" ||
            Scene_PlayRecord._jtNRP_PlayRecordPatched
        ) return;
        const parameters = PluginManager.parameters("NRP_PlayRecord");
        const suffixes = JSON.parse(parameters.Records || '[]').map(str => {
            const record = JSON.parse(str);
            return record.Suffix ? ' ' + record.Suffix : '';
        });
        const _onDmg = Game_Battler.prototype.onDamage;
        Game_Battler.prototype.onDamage = function () {
            return TranslationManager.fetchRawData(() => _onDmg.apply(this, arguments));
        };
        const _windowRect = Scene_PlayRecord.prototype.windowRect;
        Scene_PlayRecord.prototype.windowRect = function () {
            return TranslationManager.fetchRawData(() => _windowRect.apply(this, arguments));
        };
        function _installWindow(proto) {
            let frame = null;
            const current = targetWindow => frame && frame.window === targetWindow ? frame : null;
            const display = callback => TranslationManager.fetchTranslatedData(() => TranslationManager.skipPluginTrans(callback));
            const prepare = (state, measuring) => {
                if (state.suffix === undefined) {
                    state.suffix = TranslationManager.translate(suffixes[state.index]);
                }
                const text = state.value + state.suffix;
                return measuring ? text.replace(/\x1bi\[\d+\]/g, '  ').replace(/\x1bc\[\d+\]/g, '') : text;
            };
            const _CEC = proto.convertEscapeCharacters;
            proto.convertEscapeCharacters = function (text) {
                const state = current(this);
                if (!state || state.rendering) return _CEC.apply(this, arguments);
                const translated = TranslationManager.translate(text);
                state.value = display(() => _CEC.call(this, translated));
                return state.value;
            };
            const _textW = proto.textWidth;
            proto.textWidth = function (text) {
                const state = current(this);
                if (!state || state.rendering || state.value === null) return _textW.apply(this, arguments);
                return display(() => _textW.call(this, prepare(state, true)));
            };
            ['drawTextEx', 'drawText'].forEach(name => {
                const ori = proto[name];
                proto[name] = function (text) {
                    const state = current(this);
                    if (!state || state.rendering) return ori.apply(this, arguments);
                    const args = Array.prototype.slice.call(arguments);
                    args[0] = state.value === null ? TranslationManager.translate(text) : prepare(state, false);
                    state.rendering = true;
                    try {
                        return display(() => ori.apply(this, args));
                    } finally {
                        state.rendering = false;
                    }
                }
            });
            const _drawI = proto.drawItem;
            proto.drawItem = function (index) {
                const previous = frame;
                frame = TranslationManager._translationDisableDepth === 0 && TranslationManager._translatedSkipDepth === 0 ? {
                    window: this, index: index, value: null, suffix: undefined, rendering: false
                } : null;
                try {
                    return TranslationManager.fetchRawData(() => _drawI.apply(this, arguments));
                } finally {
                    frame = previous;
                }
            };
        };
        const _createW = Scene_PlayRecord.prototype.createWindow;
        let windowPatched = false;
        Scene_PlayRecord.prototype.createWindow = function () {
            if (windowPatched) return _createW.apply(this, arguments);
            const _initialize = Window_Selectable.prototype.initialize;
            Window_Selectable.prototype.initialize = function () {
                const proto = Object.getPrototypeOf(this);
                if (!windowPatched && proto.constructor.name === 'Window_PlayRecord') {
                    _installWindow(proto);
                    windowPatched = true;
                }
                return _initialize.apply(this, arguments);
            };
            try {
                return _createW.apply(this, arguments);
            } finally {
                Window_Selectable.prototype.initialize = _initialize;
            }
        };
        Scene_PlayRecord._jtNRP_PlayRecordPatched = true;
    }

    //NRP_VisualTurn.js
    //2.05
    //MZ/MV
    function patch_NRP_VisualTurn() {
        if (
            typeof Game_Enemy.prototype.visualId !== 'function' ||
            typeof BattleManager.displayActionOrders !== 'function' ||
            Game_Enemy._jtNRP_VisualTurnPatched
        ) return;
        const _name = Game_Enemy.prototype.name;
        Game_Enemy.prototype.name = function () {
            let _tName = _name.apply(this, arguments);
            if (
                TranslationManager.isRawData() || TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0 || typeof _tName !== 'string'
            ) return _tName;
            if (BattleManager.isInputting()) {
                const _visualId = this.visualId();
                if (_visualId && _tName.indexOf(_visualId + ':') === 0) {
                    _tName = TranslationManager.translate(_visualId) + _tName.slice(_visualId.length);
                }
            }
            TranslationManager._translatedSet.add(_tName);
            return _tName;
        };
        Game_Enemy._jtNRP_VisualTurnPatched = true;
    }

    //NRP_VictoryRewards.js
    //1.05
    //MZ
    function patch_NRP_VictoryRewards() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Window_Message.prototype.initVictoryRewards !== 'function' ||
            Window_Message._jtNRP_VictoryRewardsPatched
        ) return;
        const param = PluginManager.parameters('NRP_VictoryRewards');
        if (param.MessageFitWidth !== 'true' && param.MessageFitWidth !== true) return;
        const _flushTS = Window_Message.prototype.flushTextState;
        Window_Message.prototype.flushTextState = function () {
            return TranslationManager.skipPluginTrans(() => _flushTS.apply(this, arguments));
        };
        Window_Message._jtNRP_VictoryRewardsPatched = true;
    }

    //NRP_AdditionalCCScene.js
    //1.102
    //MZ
    function patch_NRP_AdditionalCCScene() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Windows_ClassSlot === 'undefined' ||
            typeof Windows_SelectClasses === 'undefined' ||
            Windows_ClassSlot._jtNRP_AdditionalCCScenePatched
        ) return;
        [
            [Windows_SelectClasses.prototype, 'makeItemList'], [Windows_ClassSlot.prototype, 'maxItems']
        ].forEach(entry => {
            const ori = entry[0][entry[1]];
            entry[0][entry[1]] = function () {
                return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => ori.apply(this, arguments)));
            }
            const _flushTS = entry[0].flushTextState;
            entry[0].flushTextState = function () {
                return TranslationManager.skipPluginTrans(() => _flushTS.apply(this, arguments));
            }
        });
        if (PluginManager.parameters('NRP_AdditionalCCScene').ClassChangeMessage) {
            const _setIW = Windows_SelectClasses.prototype.setInfoWindow;
            Windows_SelectClasses.prototype.setInfoWindow = function (infoWindow) {
                const result = _setIW.apply(this, arguments);
                if (infoWindow && !infoWindow._jtNRP_AdditionalCCSceneInfoWindowPatched) {
                    const _selectWindow = this;
                    const ori = infoWindow.callOkHandler;
                    infoWindow.callOkHandler = function () {
                        if (!_selectWindow.item()) return ori.apply(this, arguments);
                        return TranslationManager.fetchRawData(() => ori.apply(this, arguments));
                    }
                    infoWindow._jtNRP_AdditionalCCSceneInfoWindowPatched = true;
                }
                return result;
            }
        }
        Windows_ClassSlot._jtNRP_AdditionalCCScenePatched = true;
    }

    //NRP_ClassChangeScene.js
    //1.042
    //MZ
    //cant find a better entrance
    function patch_NRP_ClassChangeScene() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            Window_Selectable._jtNRP_ClassChangeScenePatched ||
            !PluginManager.parameters('NRP_ClassChangeScene').ClassList
        ) return;
        const _patchedWindows = new WeakSet();
        const _hasSuccessMsg = !!PluginManager.parameters('NRP_ClassChangeScene').ClassChangeMessage;
        const _initialize = Window_Selectable.prototype.initialize;
        Window_Selectable.prototype.initialize = function () {
            const result = _initialize.apply(this, arguments);
            //AdditionalCCScene namespace overlap
            if (typeof Windows_SelectClasses !== 'undefined' && this instanceof Windows_SelectClasses) return result;
            if (_patchedWindows.has(this) || typeof this.isActorConditionOK !== 'function' || typeof this.isClassConditionOK !== 'function' || typeof this.drawClassLevel !== 'function' || typeof this.makeItemList !== 'function' || typeof this.setInfoWindow !== 'function') return result;
            const _makeIL = this.makeItemList;
            this.makeItemList = function () {
                return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => _makeIL.apply(this, arguments)));
            };
            if (_hasSuccessMsg) {
                const _setIW = this.setInfoWindow;
                this.setInfoWindow = function (infoWindow) {
                    const value = _setIW.apply(this, arguments);
                    if (infoWindow && !_patchedWindows.has(infoWindow)) {
                        const _callOH = infoWindow.callOkHandler;
                        infoWindow.callOkHandler = function () {
                            return TranslationManager.fetchRawData(() => _callOH.apply(this, arguments));
                        };
                        _patchedWindows.add(infoWindow);
                    }
                    return value;
                }
            }
            _patchedWindows.add(this);
            return result;
        }
        Window_Selectable._jtNRP_ClassChangeScenePatched = true;
    }

    //NRP_CounterSkill.js
    //1.06
    //MV/MZ
    function patch_NRP_CounterSkill() {
        if (
            typeof Game_Battler.prototype.counterForceAction !== 'function' ||
            typeof Game_BattlerBase.prototype.isCounterRestricted !== 'function' ||
            typeof Game_Action.prototype.applyCounter !== 'function' ||
            Game_Action._jtNRP_CounterSkillPatched
        ) return;
        const _applyC = Game_Action.prototype.applyCounter;
        Game_Action.prototype.applyCounter = function () {
            return TranslationManager.fetchRawData(() => _applyC.apply(this, arguments));
        };
        Game_Action._jtNRP_CounterSkillPatched = true;
    }

    //NRP_DeadSkill.js
    //1.042
    //MZ/MV
    function patch_NRP_DeadSkill() {
        if (
            typeof Game_Battler.prototype.deadSkillForceAction !== 'function' ||
            typeof Game_Battler.prototype.resistDeadSkill !== 'function' ||
            BattleManager._jtNRP_DeadSkillPatched
        ) return;
        const _endAction = BattleManager.endAction;
        BattleManager.endAction = function () {
            return TranslationManager.fetchRawData(() => _endAction.apply(this, arguments));
        };
        //maybe add this to global override?
        const _displayA = Window_BattleLog.prototype.displayAction;
        Window_BattleLog.prototype.displayAction = function (subject, item) {
            if (!DataManager.isSkill(item)) return _displayA.apply(this, arguments);
            return TranslationManager.fetchRawData(() => _displayA.apply(this, arguments));
        };
        BattleManager._jtNRP_DeadSkillPatched = true;
    }

    //NRP_DynamicAnimationMZ.js
    //1.241
    //MZ
    //NRP_DynamicAnimation.js
    //1.29
    //MV
    function patch_NRP_DynamicAnimation() {
        if (
            typeof BaseAnimation === 'undefined' ||
            typeof DynamicAnimation === 'undefined' ||
            typeof Game_Action.prototype.isDynamicAnimation !== 'function' ||
            typeof BaseAnimation.prototype.makeAnimation !== 'function' ||
            Game_Action._jtNRP_DynamicAnimationMZPatched
        ) return;
        const wrapRaw = function (fn) {
            return function () {
                return TranslationManager.fetchRawData(() => {
                    return fn.apply(this, arguments);
                })
            }
        };
        Game_Action.prototype.isDynamicAnimation = wrapRaw(Game_Action.prototype.isDynamicAnimation);
        BaseAnimation.prototype.makeAnimation = wrapRaw(BaseAnimation.prototype.makeAnimation);
        Game_Action._jtNRP_DynamicAnimationMZPatched = true;
    }

    //NRP_DynamicMotionMZ.js
    //1.261
    //MZ
    //NRP_DynamicMotion.js
    //1.29
    //MV
    function patch_NRP_DynamicMotion() {
        if (
            typeof BaseMotion === 'undefined' ||
            typeof BaseMotion.prototype.makeMotion !== 'function' ||
            BaseMotion._jtNRP_DynamicMotionMZPatched
        ) return;
        const _makeM = BaseMotion.prototype.makeMotion;
        BaseMotion.prototype.makeMotion = function () {
            return TranslationManager.fetchRawData(() => _makeM.apply(this, arguments));
        };
        [
            'displayAction',
            'displayActionResults',
            'displayCounter',
            'displayReflection',
            'displaySubstitute',
            'displayAddedStates'
        ].forEach(name => {
            const ori = Window_BattleLog.prototype[name];
            if (typeof ori !== 'function') return;
            Window_BattleLog.prototype[name] = function () {
                return TranslationManager.fetchRawData(() => ori.apply(this, arguments));
            };
        });
        BaseMotion._jtNRP_DynamicMotionMZPatched = true;
    }

    //NRP_MagicReflection.js
    //1.03
    //MV/MZ
    //risky
    function patch_NRP_MagicReflection() {
        if (
            !PluginManager._scripts.some(name => String(name).toLowerCase() === "nrp_magicreflection") ||
            Window_BattleLog._jtNRP_MagicReflectionPatched
        ) return;
        Window_BattleLog.prototype.displayReflection = function (target) {
            this.push('performReflection', target);
            const name = TranslationManager.translate(TranslationManager.fetchRawData(() => target.name()));
            const text = TranslationManager.translate(TextManager.magicReflection).format(name);
            TranslationManager._translatedSet.add(text);
            this.push('addText', text);
        };
        Window_BattleLog._jtNRP_MagicReflectionPatched = true;
    }

    //NRP_LearnSkillList.js
    //1.09
    //MZ
    function patch_NRP_LearnSkillList() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Window_LearnSkillList === 'undefined' ||
            Window_LearnSkillList._jtNRP_LearnSkillListPatched
        ) return;
        [
            "isMatchSkillSet",
            "isMatchDisplaySkillData",
            "isLearningDisabled"
        ].forEach(name => {
            const ori = Window_LearnSkillList.prototype[name];
            if (typeof ori !== 'function') return;
            Window_LearnSkillList.prototype[name] = function () {
                return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => ori.apply(this, arguments)));
            };
        });
        Window_LearnSkillList._jtNRP_LearnSkillListPatched = true;
    }

    //NRP_MapTravel.js
    //1.08
    //MZ
    //Wordwrap combination left unhandled
    function patch_NRP_MapTravel() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            !PluginManager._scripts.some(name => String(name).toLowerCase() === 'nrp_maptravel') ||
            Window_Selectable._jtNRP_MapTravelPatched
        ) return;
        const _initialize = Window_Selectable.prototype.initialize;
        Window_Selectable.prototype.initialize = function () {
            if (typeof this.isListingSpot === 'function' && typeof this.setMapWindow === 'function' && !this._jtMTPatched) {
                const _flushTS = this.flushTextState;
                this.flushTextState = function () {
                    return TranslationManager.skipPluginTrans(() => _flushTS.apply(this, arguments));
                };
                this._jtMTPatched = true;
            }
            return _initialize.apply(this, arguments);
        };
        Window_Selectable._jtNRP_MapTravelPatched = true;
    }

    //WindowManager.js
    //2017/07/14
    //MV
    function patch_WindowManager() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof WindowManager === 'undefined' ||
            typeof Window_Base.prototype.drawTextAutoWrap !== 'function' ||
            typeof Window_Base.prototype.calcCharacterWidth !== 'function' ||
            WindowManager._jtWindowManagerPatched
        ) return;
        const _calcCW = Window_Base.prototype.calcCharacterWidth;
        Window_Base.prototype.calcCharacterWidth = function () {
            return TranslationManager.skipPluginTrans(() => _calcCW.apply(this, arguments));
        };
        WindowManager._jtWindowManagerPatched = true;
    }

    //RandomTreasure.js
    //1.4
    //MV
    function patch_RandomTreasure() {
        if (
            Utils.RPGMAKER_NAME !== 'MV' ||
            typeof Game_System.prototype.getLastRandomTreasure !== 'function' ||
            Game_Interpreter._jtRandomTreasurePatched
        ) return;
        const _pluginC = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (command === 'RandomTreasure' && args && args[0] === 'get') {
                return TranslationManager.fetchRawData(() => _pluginC.apply(this, arguments));
            }
            return _pluginC.apply(this, arguments);
        };
        Game_Interpreter._jtRandomTreasurePatched = true;
    }

    //MaterialBase.js
    //1.01
    //MZ
    function patch_MaterialBase() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof PluginManagerEx === 'undefined' ||
            typeof Game_System.prototype.getMaterialImage !== 'function' ||
            typeof Game_System.prototype.getMaterialAudio !== 'function' ||
            Game_System._jtMaterialBasePatched
        ) return;
        [
            'getMaterialImage',
            'getMaterialAudio',
            'setMaterialImage',
            'setMaterialAudio'
        ].forEach(method => {
            const ori = Game_System.prototype[method];
            if (typeof ori !== 'function') return;
            Game_System.prototype[method] = function () {
                return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => ori.apply(this, arguments)));
            };
        });
        [
            'CHANGE_IMAGE',
            'CHANGE_AUDIO',
            'SHOW_PICTURE',
            'PLAY_AUDIO'
        ].forEach(command => {
            const key = 'MaterialBase:' + command;
            const ori = PluginManager._commands[key];
            if (typeof ori !== 'function') return;
            PluginManager._commands[key] = function () {
                return TranslationManager.fetchRawData(() => TranslationManager.disablePluginTrans(() => ori.apply(this, arguments)));
            };
        });
        Game_System._jtMaterialBasePatched = true;
    }

    //ItemCombinationMZ.js
    //1.1.0
    //MZ
    //Scene_CraftingMenu detection isnt 100p safe
    function patch_ItemCombinationMZ() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Game_Party.prototype.populateCraftingRecipes !== 'function' ||
            Game_Party._jtItemCombinationMZPatched
        ) return;
        const _populateCR = Game_Party.prototype.populateCraftingRecipes;
        Game_Party.prototype.populateCraftingRecipes = function () {
            return TranslationManager.fetchRawData(() => _populateCR.apply(this, arguments));
        };
        ['learn', 'forget', 'changeChance'].forEach(command => {
            const key = 'ItemCombinationMZ:' + command;
            const ori = PluginManager._commands[key];
            if (typeof ori !== 'function') return;
            PluginManager._commands[key] = function () {
                return TranslationManager.fetchRawData(() => ori.apply(this, arguments));
            };
        });
        function _hasMethods(target, names) {
            return !!target && names.every(name => typeof target[name] === 'function');
        };
        function _hasOwnMethods(target, names) {
            return !!target && names.every(name => typeof target[name] === 'function' && Object.prototype.hasOwnProperty.call(target, name));
        };
        const _patchedPrototypes = new WeakSet();
        const _initialize = Window_Command.prototype.initialize;
        Window_Command.prototype.initialize = function () {
            const proto = Object.getPrototypeOf(this);
            if (
                _hasMethods(SceneManager._scene, ['updateDetails', 'createDetailsWindow', 'createCombineWindow', 'onDetailsOk', 'onDetailsCancel']) &&
                _hasOwnMethods(proto, ['numVisibleRows', 'addOriginalCommands', 'isCurrentItemEnabled', 'selectLast', 'makeCommandList', 'processOk']) &&
                !_patchedPrototypes.has(proto)
            ) {
                const _addOC = proto.addOriginalCommands;
                proto.addOriginalCommands = function () {
                    return TranslationManager.fetchRawData(() => _addOC.apply(this, arguments));
                };
                _patchedPrototypes.add(proto);
            }
            return _initialize.apply(this, arguments);
        };
        const _initializeAno = Window_Base.prototype.initialize;
        Window_Base.prototype.initialize = function () {
            const proto = Object.getPrototypeOf(this);
            if (
                _hasOwnMethods(proto, ['drawDetailsName', 'drawIngredient', 'drawComboChance', 'drawFailure']) &&
                !_patchedPrototypes.has(proto)
            ) {
                const _drawDW = proto.drawDetailsName;
                proto.drawDetailsName = function () {
                    return TranslationManager.skipPluginTrans(() => _drawDW.apply(this, arguments));
                };
                _patchedPrototypes.add(proto);
            };
            return _initializeAno.apply(this, arguments);
        };
        Game_Party._jtItemCombinationMZPatched = true;
    }

    //ExtraWindow.js
    //1.01
    //MZ
    //not rlly inline w/ average patch logic
    function patch_ExtraWindow() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            typeof Window_SceneExtra === 'undefined' ||
            Window_SceneExtra._jtExtraWindowPatched ||
            typeof Window_SceneExtra.prototype.refresh !== 'function' ||
            typeof Window_SceneExtra.prototype.drawAllText !== 'function'
        ) return;
        Window_SceneExtra.prototype.drawAllText = function () {
            const newText = TranslationManager.fetchRawData(() => PluginManagerEx.convertEscapeCharacters(this._data.Text));
            if (this._text !== newText) {
                this._text = newText;
                this.contents.clear();
                this.drawTextEx(newText, 0, 0, this._data.width);
            }
        };
        Window_SceneExtra.prototype.refresh = function () {
            this.drawAllText();
            TranslationManager.fetchRawData(() => {
                if (this._data.WindowSkin) {
                    this.windowskin = ImageManager.loadSystem(this._data.WindowSkin);
                }
            });
        };
        Window_SceneExtra._jtExtraWindowPatched = true;
    }

    //EventCommandByCode.js
    //MZ
    function patch_EventCommandByCode() {
        if (
            Utils.RPGMAKER_NAME !== 'MZ' ||
            PluginManager._jtEventCommandByCodePatched ||
            typeof PluginManager._commands['EventCommandByCode:execute'] !== 'function'
        ) return;
        const ori = PluginManager._commands['EventCommandByCode:execute'];
        PluginManager._commands['EventCommandByCode:execute'] = function () {
            return TranslationManager.fetchRawData(() => ori.apply(this, arguments));
        };
        [
            [Window_NameEdit.prototype, 'charWidth'],
            [Window_NameEdit.prototype, 'drawChar'],
            [Window_NameInput.prototype, 'drawItem']
        ].forEach(entry => {
            const ori = entry[0][entry[1]];
            if (typeof ori !== 'function') return;
            entry[0][entry[1]] = function () {
                return TranslationManager.skipPluginTrans(() => ori.apply(this, arguments));
            };
        });
        PluginManager._jtEventCommandByCodePatched = true;
    }

    //#endregion
    //#region record only plugins
    //DestinationWindow.js
    //1.7.0
    //MV
    //iconIndex@updateText isnt risk free, but discard

    //AutoTranslation.js
    //2.0.1
    //MZ
    //Take it as incompatible rn

    //ConvertKinokoTakenoko.js
    //idk tf its for, discard

    //EscapeInvalidate.js
    //1.1.2
    //MZ
    //on hold

    //NameBoxNoUse.js
    //1.1.1
    //MZ
    //maybe trans preproc needed?

    //MessageAutoPrefix.js
    //1.3.1
    //adding prefix should be fine for translate()

    //AnotherNewGame.js
    //4.3.4
    //MZ
    //nobody d read \N[n] in logic

    //BattleEndMessage.js
    //1.1.0
    //MZ
    //might miss some trans

    //CommandSkill.js
    //1.5.0
    //MZ
    //nobody d read \N[n] in condition logic

    //GameClearFlag.js
    //1.0.0
    //MZ
    //same as above

    //StartUpFullScreen.js
    //1.7.0
    //MZ
    //same

    //CustomizeErrorScreen.js
    //discard

    //MenuBarAddition.js
    //window title command, discard

    //TextScriptBaseScript.js related Triacontane extension
    //MZ
    //on hold

    //MKR_InputEnemyName.js
    //MV
    //don seem to be user spcae plugin

    //TMWindowCaption.js
    //MV
    //edge case can live w/ ig

    //TMTextEscape.js
    //1.4.1
    //MV
    //discard

    //FTKR_SkillExpansion.js
    //MV
    //no usage example using skill name/desc in logic so leave as is

    //DarkPlasma_AutoHighlight.js
    //2.0.2
    //MV
    //ll have to hijack its loading n reimplement its logic 
    //but losing text highlight wont hurt much in most cases ig

    //DarkPlasma_SimpleQuest.js
    //1.2.0
    //idk how \n gonna be handled by mtool

    //DarkPlasma_TinyMedal.js
    //3.2.0
    //MZ
    //dunno how mtool handle its message, plus object not exposed, discard fn

    //TorigoyaMZ_ActorEnemy.js
    //0.2.1
    //MZ
    //wont break the game w/o patch ig

    //NUUN_CommandIcon.js
    //1.6.1
    //MZ
    //all vanilla entrace, hard to patch, discard.

    //LL_StandingPictureMV.js
    //2.7.0
    //MV
    //don wanna bother w/ convertEscapeCharacters override under Window_Base

    //VisuMZ_2_PictureChoices.js
    //1.00
    //MZ
    //assume it should always be used w/ VisuMZ_1_MessageCore ig

    //EST_AUTO_TEXT_COLOR_PLUS.js
    //1.9
    //MV
    //likely not compatible but wont hurt much ig
    //too complicated to patch w/ YEP message core

    //EST_AUTO_TEXT_COLOR_MZ.js
    //1.0
    //MZ
    //similar as above

    //NRP_AutoHeal.js
    //1.03
    //MV/MZ
    //possible restrans in log

    //NRP_LevelUpDirection.js
    //1.022
    //MV
    //possible retrans

    //NRP_ForgetLowerSkill.js
    //1.031
    //MV
    //same as above

    //NRP_MultiLanguage.js
    //1.06
    //MZ
    //idk

    //NRP_WordWrap.js
    //1.02
    //MZ
    //too vague to patch

    //NRP_AdditionalClasses.js
    //1.14
    //MZ
    //possible retrans

    //NRP_LearnSkillListReserve.js
    //1.04
    //MZ
    //too complicated for text retrans patch

    //TinyGetInfoWndMZ.js
    //1.1.0
    //MZ
    //tiny retrans

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
        patch_ItemNameEscape();
        patch_SceneGlossary();
        patch_TRP_CORE();
        patch_OrignalMessage();
        patch_TickerManager();
        patch_TorigoyaMZ_NotifyMessage_AddonGetItem();
        patch_TorigoyaMZ_NotifyMessage();
        patch_PictureAnimation();
        //patch_PictureAnimation_MZ();
        patch_SimpleVoice();
        patch_SimpleVoice_MZ();
        patch_PictureVariableSetting();
        patch_SystemSoundCustomize();
        patch_TF_LayeredMap();
        patch_RestrictionTargetSkill();
        patch_SelfSwitchTemporary();
        patch_DTextPicture();
        patch_DTextPicture_MZ();
        patch_Chronus();
        patch_MKR_PlayerSensor();
        patch_MakeScreenCapture();
        patch_MakeScreenCapture_MZ();
        patch_MessageWindowPopup();
        patch_MessageWindowPopup_MZ();
        patch_TraceEvent();
        patch_DynamicVariables();
        patch_DynamicActorGraphic();
        patch_DynamicDatabaseNote();
        patch_MoviePicture();
        patch_MoviePicture_MZ();
        patch_FileDownloader();
        patch_StatusBustImage();
        patch_BattleActorFaceVisibility();
        patch_BattleEffectPopup();
        patch_PictureCallCommon();
        patch_PictureCallCommon_MZ();
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
        patch_CounterExtend_MZ();
        patch_DynamicEquipParam();
        patch_SubstituteExtend();
        patch_SealActorCommand();
        patch_VariableControlItem();
        patch_WaitInterpreterCondition();
        patch_HitAndEvasionExtend();
        patch_SaveFileLoadOnly();
        patch_ShakeOnDamage();
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
        patch_DirectlyAttackEffect();
        patch_CharacterGraphicExtend();
        patch_SceneCustomMenu();
        patch_EroStatusFix();
        patch_MapNameExtend();
        patch_CharacterGraphicManager();
        patch_CharacterPictureManager();
        patch_CharacterPictureManager_MZ();
        patch_FlexibleBattleBgm();
        patch_FacePicture();
        patch_TkoolMV_PluginCommandBook();
        patch_EventReSpawn();
        patch_RetryBattle();
        patch_NobleMushroom();
        patch_GameStartEval();
        patch_CustomizeConfigItem();
        patch_MenuSubCommand();
        patch_MenuSubCommand_MZ();
        //patch_DynamicBattlerParam();
        //patch_ParamTransfer();
        //patch_ParamTransfer_MZ();
        //patch_TraitConditions();
        patch_NpcFollower();
        patch_CharacterPopupDamage();
        patch_MovieManager();
        patch_BattlerGraphicExtend();
        patch_MessageNameCommon();
        patch_PictureNameVariable();
        patch_PictureGrouping();
        patch_NameInputNg();
        patch_AccumulateState();
        patch_AccumulateState_MZ();
        patch_ActionEffectExtend();
        patch_AutoActionExclude();
        patch_BattleLogReplace();
        patch_ChargeTimeControl();
        patch_ConditionalXparam();
        patch_DamageSeEffective();
        //patch_EncounterFormula();
        //patch_EnemyOverlay();
        patch_ExtraGauge();
        patch_ItemStealAction();
        patch_PartyCommandScene();
        patch_RemoveStateExtend();
        patch_SkillChange();
        patch_SkillHitCondition();
        patch_StateEnchanter();
        patch_StateTrigger();
        patch_TitleCall();
        patch_TemplateEvent();
        //patch_DescriptionExtend();
        //patch_ProfileExtend();
        //patch_AttackChain();
        patch_TitleNewGameOnly();
        patch_CommonWithParameter();
        patch_MNKR_HzRandomListMZ();
        patch_MNKR_RandomTreasure();
        patch_MNKR_RandomActorNameMV();
        patch_MNKR_MessageAlignCenterMV();
        patch_MNKR_EnemyIcon();
        patch_MKR_ControlCharacterEx();
        patch_MOG_SceneMenu();
        patch_MOG_BattleCommands();
        patch_MOG_AnimatedText();
        patch_MOG_AnimatedText_MZ();
        patch_MOG_TimeSystem();
        patch_MOG_Music_Book();
        patch_MOG_TreasurePopup();
        patch_MOG_TreasurePopup_MZ();
        patch_MOG_TreasureHud();
        patch_MOG_TreasureHud_MZ();
        patch_MOG_BattleCursor();
        patch_TMTyping();
        patch_TMAnimeLight();
        patch_TMGoogleMaps();
        patch_TMLogWindow();
        patch_TMNamePop();
        patch_YEP_AdvSwVar();
        patch_YEP_SelfSwVar();
        patch_YEP_SaveCore();
        patch_YEP_X_NewGamePlus();
        patch_YEP_BaseParamControl();
        patch_YEP_SpecialParamFormula();
        patch_YEP_ItemCore();
        patch_YEP_X_AttachAugments();
        patch_YEP_X_CondShopPrices();
        patch_YEP_X_EquipRequirements();
        patch_YEP_X_HideShowShopItems();
        patch_YEP_X_ItemDurability();
        patch_YEP_X_ItemDisassemble();
        patch_YEP_X_ItemRequirements();
        patch_YEP_X_EquipSkillTiers();
        patch_YEP_KeyboardConfig();
        patch_FTKR_AddRoutineMoveCommands();
        patch_FTKR_AISkillEvaluate();
        patch_FTKR_AutoStateConditions();
        patch_FTKR_AutoInvokeSkill();
        patch_FTKR_BattleAbortConditions();
        patch_FTKR_BattleActionPoints();
        patch_FTKR_ConvertEscapeCharactersInScript();
        patch_FTKR_CustomSimpleActorStatus();
        patch_FTKR_CSS_CustomizeBattleResults();
        patch_FTKR_CSS_BattleStatus();
        patch_FTKR_DamageFixedStates();
        patch_FTKR_ExBattleCommand();
        patch_FTKR_ExBattleEvent();
        patch_FTKR_ExGuardEffect();
        patch_FTKR_ExItemBox();
        patch_FTKR_ExItemConfig_Damage();
        patch_FTKR_ExItemConfig_Effect();
        patch_FTKR_ExItemConfig_ItemBasic();
        patch_FTKR_ExItemConfig_Required()
        patch_FTKR_ExSvMotion();
        patch_FTKR_ExVariablesChange();
        patch_FTKR_ExTraitSetting();
        patch_FTKR_ItemCompositionSystem();
        patch_FTKR_ItemSelfVariables()
        patch_FTKR_ItemSubCommand();
        patch_FTKR_PopupSpriteMessage();
        patch_FTKR_OriginalSceneWindow();
        patch_FTKR_SetupTroops();
        patch_FTKR_SEP_ShowSkillStatus();
        patch_FTKR_ShowPictureBalloon();
        patch_FTKR_SkillCounter();
        patch_FTKR_SkillSubCommand();
        patch_DarkPlasma_ConcurrentParty();
        patch_DarkPlasma_LicenseManager();
        patch_DarkPlasma_NameWindow();
        patch_DarkPlasma_NameWindow_MZ();
        patch_DarkPlasma_AutoLineBreak();
        patch_DarkPlasma_TextLog();
        patch_DarkPlasma_TextLog_MZ();
        patch_DarkPlasma_SkillDetail();
        patch_DarkPlasma_ComposePicture();
        patch_DarkPlasma_PartialTextColor();
        patch_DarkPlasma_AutoHighlight();
        patch_DarkPlasma_DisplayDatabaseDetailWindow();
        patch_DarkPlasma_ChoiceExtension();
        patch_DarkPlasma_FormationInBattle();
        patch_TorigoyaMZ_Bookshelf();
        patch_Torigoya_Bookshelf();
        patch_Torigoya_SkillCutIn();
        patch_Torigoya_SkillChangeTo();
        patch_Torigoya_Achievement2();
        patch_NUUN_CallingEnemy();
        patch_NUUN_ItemBook();
        patch_NUUN_EnemyBook();
        patch_NUUN_MenuCommandEX();
        patch_NUUN_MenuScreenEX();
        patch_NUUN_StatusScreen();
        patch_NUUN_SystemDatabaseUnlimited();
        patch_NUUN_BattleStyleEX();
        patch_LL_MenuScreenCustomMV();
        patch_LL_MenuScreenStatusMV();
        patch_LL_GalgeChoiceWindowMV();
        patch_LL_GalgeChoiceWindow();
        patch_VisuMZ_1_BattleCore();
        patch_VisuMZ_1_ItemsEquipsCore();
        patch_VisuMZ_1_SkillsStatesCore();
        patch_VisuMZ_1_OptionsCore();
        patch_VisuMZ_3_SkillCooldowns();
        patch_VisuMZ_3_EnemyLevels();
        patch_VisuMZ_4_DiceRollsRngSeeds();
        patch_VisuMZ_4_CombatLog();
        patch_VisuMZ_2_ItemCraftingSys();
        patch_GALV_VisualNovelChoices();
        patch_Galv_MapTravel();
        patch_GALV_MessageBusts();
        patch_GALV_MessageBustsMZ();
        patch_EST_PHONE_MENU_MZ();
        patch_EST_PHONE_ADDON_BASICMENU();
        patch_EST_PRICE_FORMULA_MZ();
        patch_NRP_BattleTargetCursor();
        patch_NRP_CallEnemy();
        patch_NRP_CombinationSkill();
        patch_NRP_ChargeSkill();
        patch_NRP_Substitute();
        patch_NRP_OriginalRewards();
        patch_NRP_U_SkillTreeReserve();
        patch_NRP_WindowBattleLogLayout();
        patch_NRP_MessagePicture();
        patch_NRP_EvalPluginCommand();
        patch_NRP_GetItemCommon();
        patch_NRP_PictureToFace();
        patch_NRP_PlayRecord();
        patch_NRP_VisualTurn();
        patch_NRP_VictoryRewards();
        patch_NRP_AdditionalCCScene();
        patch_NRP_ClassChangeScene();
        patch_NRP_CounterSkill();
        patch_NRP_DeadSkill();
        patch_NRP_DynamicAnimation();
        patch_NRP_DynamicMotion();
        patch_NRP_MagicReflection();
        patch_NRP_LearnSkillList();
        patch_NRP_MapTravel();
        patch_WindowManager();
        patch_RandomTreasure();
        patch_MaterialBase();
        patch_ItemCombinationMZ();
        patch_ExtraWindow();
        patch_EventCommandByCode();
    };
    //#endregion

    function _registerSGCategoryTrans() {
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

        const dataArray = [$dataItems, $dataArmors, $dataWeapons];
        dataArray.forEach(data => {
            if (!data || !Array.isArray(data)) return;
            data.forEach(function (item) {
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
        })
    };

    //#region Initialization
    // --- Core Logic: Load the Translation Dictionary ---
    // This function is aliased to load our custom data before the game starts.
    const _DataManager_loadDatabase = DataManager.loadDatabase;
    DataManager.loadDatabase = function () {
        DataManager._translationApplied = false;
        TranslationManager._descriptionTemplateStates = new WeakMap();
        if (!DataManager._jtDatabaseOnLoadWrapped) {
            const _onLoad = DataManager.onLoad;
            DataManager.onLoad = function (object) {
                const databaseObject = this._databaseFiles.some(function (file) {
                    return window[file.name] === object;
                });
                let previousDescriptions = null;
                if (
                    databaseObject &&
                    Array.isArray(object) &&
                    typeof this.findTemplate === 'function' &&
                    typeof this.findOptionLabel === 'function'
                ) {
                    previousDescriptions = object.map(function (data) {
                        return !!(data && data.hasOwnProperty('prevDesc'));
                    });
                }
                const result = databaseObject ?
                    TranslationManager.fetchRawData(() => {
                        return TranslationManager.disablePluginTrans(() => {
                            return _onLoad.apply(this, arguments);
                        });
                    }) : _onLoad.apply(this, arguments);
                observeDescriptionTemplates(object, previousDescriptions);
                return result;
            };
            DataManager._jtDatabaseOnLoadWrapped = true;
        }

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
        _DataManager_loadDatabase.apply(this, arguments);
    };

    // Patch DataManager.onLoad to run translation after all database files are loaded
    const _DataManager_onLoad = DataManager.onLoad;
    DataManager._translationApplied = false;
    DataManager.onLoad = function (object) {
        _DataManager_onLoad.call(this, object);
        /*
        if (DataManager.isDatabaseLoaded() && !DataManager._translationApplied && TranslationManager.isInitialized()) {
            _registerSGCategoryTrans();
            TranslationManager.translateCommonData();
            patchPlugin();
            DataManager._translationApplied = true;
        }
        */
        //this injection can be inconsistent when DT loaded

        // Translate map data when it's loaded
        if (object === $dataMap && TranslationManager.isInitialized()) {
            TranslationManager.translateDataMap();
        }

        // TranslationManager.saveDictionary();
    };

    //new injection point
    const _Scene_Boot_isReady = Scene_Boot.prototype.isReady;
    Scene_Boot.prototype.isReady = function () {
        const ready = _Scene_Boot_isReady.apply(this, arguments);
        if (ready && !DataManager._translationApplied && TranslationManager.isInitialized()) {
            patch_DescriptionTemplate();
            _registerSGCategoryTrans();
            patch_YEP_MessageCore();
            patch_VisuMZ_1_MessageCore();
            TranslationManager.translateCommonData();
            patchPlugin();
            DataManager._translationApplied = true;
        }
        return ready;
    }

    window.TranslationManager = TranslationManager;
    //#endregion

    //#region Patches
    // Choices and other command window text
    //removing this might introduce mismatch, but mtools' text extraction is to blame?
    //post proc like AutoRubyReplace.js does exist, whilist trans here also break their logic
    //hard to restore raw string from translated commands, n commands r processed during its call chain, maintaining dynamic structure is way 2 complicated
    //maybe translate on per plugin basis
    /*
    const _Window_Command_addCommand = Window_Command.prototype.addCommand;
    Window_Command.prototype.addCommand = function (name, symbol, enabled = true, ext = null) {
        if (TranslationManager._translationDisableDepth > 0) {
            return _Window_Command_addCommand.apply(this, arguments);
        }
        return _Window_Command_addCommand.call(this, TranslationManager.translate(name), symbol, enabled, ext);
    };
    */

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
    //Window_BattleLog.prototype.addText follow up
    const _Window_BattleLog_drawLineText = Window_BattleLog.prototype.drawLineText;
    Window_BattleLog.prototype.drawLineText = function () {
        return TranslationManager.skipPluginTrans(() => _Window_BattleLog_drawLineText.apply(this, arguments));
    };

    //Bitmap related single char retrans problem should be fixed by these two patches
    if (typeof Window_Base.prototype.flushTextState === 'function') {
        const _flushTS = Window_Base.prototype.flushTextState;
        Window_Base.prototype.flushTextState = function () {
            return TranslationManager.skipPluginTrans(() => {
                return _flushTS.apply(this, arguments);
            })
        };
    }
    if (typeof Window_Base.prototype.processNormalCharacter === 'function') {
        const _processNC = Window_Base.prototype.processNormalCharacter;
        Window_Base.prototype.processNormalCharacter = function () {
            return TranslationManager.skipPluginTrans(() => {
                return _processNC.apply(this, arguments);
            })
        };
    }

    // Thanks to the improvement in translate function, this is be acceptable now.
    // Window_Base.drawText is implemented in terms of Bitmap.drawText, so patching Bitmap.drawText should cover most cases.
    const _Bitmap_drawText = Bitmap.prototype.drawText;
    Bitmap.prototype.drawText = function (text, x, y, maxWidth, lineHeight, align) {
        if (TranslationManager._translationDisableDepth > 0 || TranslationManager._translatedSkipDepth > 0) {
            return _Bitmap_drawText.call(this, text, x, y, maxWidth, lineHeight, align);
        }
        if (typeof (text) === 'string') {
            /*
            if (TranslationManager._inRecent(text)) {
                return _Bitmap_drawText.call(this, text, x, y, maxWidth, lineHeight, align);
            }
            */
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
            /*
            if (TranslationManager._inRecent(text)) {
                return _Bitmap_measureTextWidth.call(this, text);
            }
            */
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
    //variable values trans
    const _Game_Variables_value = Game_Variables.prototype.value;
    Game_Variables.prototype.value = function (variableId) {
        const value = _Game_Variables_value.call(this, variableId);
        if (!TranslationManager.isRawData() &&
            TranslationManager._CECDepth > 0 &&
            typeof value === 'string') {
            return TranslationManager.translate(value);
        };
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
