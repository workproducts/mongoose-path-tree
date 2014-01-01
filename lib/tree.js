var Schema = require('mongoose').Schema;

module.exports = exports = tree;

/**
 * @class tree
 * Tree Behavior for Mongoose
 *
 * Implements the materialized path strategy with cascade child re-parenting
 * on delete for storing a hierarchy of documents with mongoose
 *
 * @param  {mongoose.Schema} schema
 * @param  {Object} options
 */
function tree(schema, options) {
    var pathSeparator = options && options.pathSeparator || '#'
        , onDelete = options && options.onDelete || 'DELETE'; //'REPARENT'

    /**
     * Add parent and path properties
     *
     * @property {ObjectID} parent
     * @property {String} path
     */
    schema.add({
        parent: {
            type: Schema.ObjectId,
            set: function (val) {
                return (val instanceof Object && val._id) ? val._id : val;
            },
            index: true
        },
        path: {
            type: String,
            index: true
        }
    });

    /**
     * Pre-save middleware
     * Build or rebuild path when needed
     *
     * @param  {Function} next
     */
    schema.pre('save', function preSave(next) {
        var isParentChange = this.isModified('parent');

        if (this.isNew || isParentChange) {
            if (!this.parent) {
                this.path = this._id.toString();
                return next();
            }

            var self = this;
            this.collection.findOne({ _id: this.parent }, function (err, doc) {
                if (err) return next(err);

                var previousPath = self.path;
                self.path = doc.path + pathSeparator + self._id.toString();

                if (isParentChange) {
                    // When the parent is changed we must rewrite all children paths as well
                    self.collection.find({ path: { '$regex': '^' + previousPath + pathSeparator } }, function (err, cursor) {
                        if (err) return next(err);

                        var stream = cursor.stream();
                        stream.on('data', function (doc) {
                            var newPath = self.path + doc.path.substr(previousPath.length);
                            self.collection.update({ _id: doc._id }, { $set: { path: newPath } }, function (err) {
                                if (err) return next(err);
                            });
                        });
                        stream.on('close', next);
                        stream.on('error', next);
                    });
                } else {
                    next();
                }
            });
        } else {
            next();
        }
    });

    /**
     * Pre-remove middleware
     *
     * @param  {Function} next
     */
    schema.pre('remove', function preRemove(next) {
        if (!this.path)
            return next();

        if (onDelete == 'DELETE') {
            this.collection.remove({ path: { '$regex': '^' + this.path + pathSeparator } }, next);
        }
        else {
            var self = this,
                newParent = this.parent,
                previousParent = this._id;

            // Update parent property from children
            this.collection.find({ parent: previousParent }, function (err, cursor) {
                if (err) return next(err);
                var stream = cursor.stream();
                stream.on('data', function streamOnData(doc) {
                    self.collection.update({ _id: doc._id }, { $set: { parent: newParent } }, function (err) {
                        if (err) return next(err);
                    });
                });
                stream.on('close', function streamOnClose() {
                    // Cascade update Path
                    self.collection.find({ path: { $regex: previousParent + pathSeparator} }, function (err, cursor) {

                        var subStream = cursor.stream();
                        subStream.on('data', function subStreamOnData(doc) {
                            var newPath = doc.path.replace(previousParent + pathSeparator, '');
                            self.collection.update({ _id: doc._id }, { $set: { path: newPath } }, function (err) {
                                if (err) return next(err);
                            });
                        });
                        subStream.on('close', next);
                        subStream.on('error', next);
                    });
                });
                stream.on('error', next);
            });
            //this.collection.update({})
        }
    });

    /**
     * @method getChildren
     *
     * @param  {[type]}   recursive
     * @param  {Function} next
     * @return {Model}
     */
    schema.methods.getChildren = function getChildren(recursive, next) {
        if (typeof(recursive) === "function") {
            next = recursive;
            recursive = false;
        }
        var filter = recursive ? { path: { $regex: '^' + this.path + pathSeparator } } : { parent: this._id };
        return this.model(this.constructor.modelName).find(filter, next);
    };

    /**
     * @method getParent
     *
     * @param  {Function} next
     * @return {Model}
     */
    schema.methods.getParent = function getParent(next) {
        return this.model(this.constructor.modelName).findOne({ _id: this.parent }, next);
    };

    /**
     * @method getAncestors
     *
     * @param  {Function} next
     * @return {Model}
     */
    schema.methods.getAncestors = function getAncestors(next) {
        if (this.path) {
            var ids = this.path.split(pathSeparator);
            ids.pop();
        } else {
            var ids = [];
        }
        var filter = { _id: { $in: ids } };
        return this.model(this.constructor.modelName).find(filter, next);
    };


    /**
     * @method getChildrenTree
     *
     * @param  {Document} root (optional)
     * @param  {Object}   args (optional)
     *         {Object}        .filters (like for mongo find)
     *  {Object} or {String}   .fields  (like for mongo find)
     *         {Object}        .options (like for mongo find})
     *         {Number}        .minLevel, default 1
     *         {Boolean}       .recursive
     *         {Boolean}       .allowEmptyChildren
     * @param  {Function} next
     * @return {Model}
     */
    schema.statics.getChildrenTree = function getChildrenTree(root, args, cb) {

        console.log('model' in root);
        if ("function" === typeof(root))
        {
            cb = root;
            root = null;
            args = {};
        }
        else if ("function" === typeof(args)) {
            cb = args

            if ("model" in root) {
                args = {};
            }
            else
            {
                args = root
                root = null
            }
        }

        var filters = args.filters || {};
        var fields = args.fields || null;
        var options = args.options || {};
        var minLevel = args.minLevel || 1;
        var recursive = args.recursive != undefined ? args.recursive : true;
        var allowEmptyChildren = args.allowEmptyChildren != undefined ? args.allowEmptyChildren : true;

        if (!cb)
            throw new Error('no callback defined when calling getChildrenTree');

        // filters: Add recursive path filter or not
        if (recursive) {
            if (root)
                filters.path = { $regex: '^' + root.path + pathSeparator };

            if (filters.parent === null)
                delete filters.parent;

        } else {
            if (root)
                filters.parent = root._id;
            else
                filters.parent = null
        }

        // fields: Add path and parent in the result if not already specified
        if (fields) {
            if (fields instanceof Object) {
                if (!fields.hasOwnProperty('path'))
                    fields['path'] = 1;
                if (!fields.hasOwnProperty('parent'))
                    fields['parent'] = 1;
            }
            else {
                if (!fields.match(/path/))
                    fields += ' path';
                if (!fields.match(/parent/))
                    fields += ' parent';
            }
        }

        // options:sort , path sort is mandatory
        if (!options.sort) options.sort = {};
        options.sort.path = 1;
        options.lean = true;

        return this.find(filters, fields, options, function (err, results) {
            if (err) throw err;

            var getLevel = function (path) {
                return path ? path.split(pathSeparator).length : 0;
            };

            var createChildren = function (arr, node, level) {
                if (level == minLevel) {
                    if (allowEmptyChildren)
                        node.children = [];
                    return arr.push(node);
                }
                var nextIndex = arr.length - 1;
                var myNode = arr[nextIndex];
                if (!myNode) {
                    //console.log("Tree node " + node.name + " filtered out. Level: " + level + " minLevel: " + minLevel);
                    return []
                } else {
                    createChildren(myNode.children, node, level - 1);
                }
            };

            var finalResults = [];
            var rootLevel = 1;
            if (root)
                rootLevel = getLevel(root.path) + 1;

            if (minLevel < rootLevel) {
                minLevel = rootLevel
            }

            for (var r in results) {
                var level = getLevel(results[r].path);
                createChildren(finalResults, results[r], level);
            }

            cb(err, finalResults);

        });
    };

    schema.methods.getChildrenTree = function(args, cb) {
        this.constructor.getChildrenTree(this, args, cb)
    };

    /**
     * @property {Number} level <virtual>
     */
    schema.virtual('level').get(function virtualPropLevel() {
        return this.path ? this.path.split(pathSeparator).length : 0;
    });
}
