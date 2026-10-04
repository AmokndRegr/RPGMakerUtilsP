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

            //don handle override property since its mever specified as this line put
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

            //DynamicTemplate keys preservation
            if (this._descriptionTemplateTransDepth > 0) {
                const placeholders = /\$\{(.*?)}/g;
                let placeholder;
                while ((placeholder = placeholders.exec(text))) {
                    for (let index = placeholder.index; index < placeholders.lastIndex; index++) {
                        occupied[index] = true;
                        freeCount--;
                    }
                }
            }

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
        template = template.replace(/\\n/g, '\n');
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
    //MV
    //hard coded
    function patch_DescriptionTemplate() {
        [$dataItems, $dataSkills, $dataWeapons, $dataArmors].forEach(function (array) {
            if (!array) return;
            array.forEach(function (data) {
                const state = data && TranslationManager._descriptionTemplateStates.get(data);
                if (!state) return;
                const descriptor = Object.getOwnPropertyDescriptor(data, 'description');
                if (!descriptor || descriptor.get !== state.nativeGetter) return;
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
        if (typeof Game_Battler.prototype.getPictureName === 'function') {
            Game_Battler.prototype.getPictureName = wrap(Game_Battler.prototype.getPictureName);
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
                    const sprite = actor && this._standSprites?.get(actor.actorId());
                    const pictureParam = sprite?._pictures;
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
    function patch_EventReSpawn() {
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
    function patch_NobleMushroom() {
        if (typeof Game_Interpreter.prototype.pluginCommandBlueMushroom !== 'function' ||
            typeof Game_Message.prototype.popupNameInputPrompt !== 'function' ||
            typeof DataManager.saveGameAuto !== 'function' ||
            Game_Interpreter._jtNobleMushroomPatched
        ) return;

        const bmCommands = new Set([
            'タイプ変更', 'CHANGE_TYPE',
            'ノベルウィンドウ位置設定', 'SET_RECT_NOVEL_WINDOW',
            'ノベルコマンド位置設定', 'SET_RECT_NOVEL_COMMAND'
        ])

        const _pluginCBM = Game_Interpreter.prototype.pluginCommandBlueMushroom;
        Game_Interpreter.prototype.pluginCommandBlueMushroom = function (command, args) {
            if (typeof command !== 'string' ||
                !bmCommands.has(command.toUpperCase())) {
                return _pluginCBM.apply(this, arguments);
            }
            return TranslationManager.fetchRawData(() => {
                return TranslationManager.disablePluginTrans(() => {
                    return _pluginCBM.apply(this, arguments);
                })
            })
        }

        const _popupNIP = Game_Message.prototype.popupNameInputPrompt;
        Game_Message.prototype.popupNameInputPrompt = function () {
            return TranslationManager.fetchRawData(() => {
                return _popupNIP.apply(this, arguments);
            })
        }

        const _saveGA = DataManager.saveGameAuto;
        DataManager.saveGameAuto = function () {
            return TranslationManager.fetchRawData(() => {
                return _saveGA.apply(this, arguments);
            })
        }

        Game_Interpreter._jtNobleMushroomPatched = true;
    }

    //GameStartEval.js
    //1.0.0
    //MV
    //wats this plugin for tho
    function patch_GameStartEval() {
        const enabled = $plugins.some(function (plugin) {
            return plugin.status && plugin.name === 'GameStartEval;'
        });
        if (!enabled || Scene_Boot._jtGameStartEvalPatched) return;

        const _start = Scene_Boot.prototype.start;
        Scene_Battle.prototype.start = function () {
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

    //DynamicBattlerParam.js
    //2.0.2
    //MV
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
        if (typeof Game_BattlerBase.prototype.executeParamFormula !== 'function' ||
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

    //DestinationWindow.js
    //1.7.0
    //MV
    //iconIndex@updateText isnt risk free, but discard

    //AutoTranslation.js
    //2.0.1
    //MZ
    //Take it as incompatible rn

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
        patch_SimpleVoice();
        patch_SimpleVoice_MZ();
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
        patch_MoviePicture_MZ();
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
        patch_DynamicBattlerParam();
        patch_ParamTransfer();
        patch_TraitConditions();
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
            registerSGCategoryTrans();
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
            registerSGCategoryTrans();
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
    const _Window_Command_addCommand = Window_Command.prototype.addCommand;
    Window_Command.prototype.addCommand = function (name, symbol, enabled = true, ext = null) {
        if (TranslationManager._translationDisableDepth > 0) {
            return _Window_Command_addCommand.apply(this, arguments);
        }
        return _Window_Command_addCommand.call(this, TranslationManager.translate(name), symbol, enabled, ext);
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
