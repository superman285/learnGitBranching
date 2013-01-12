var _ = require('underscore');
var Backbone = require('backbone');
var Q = require('q');

var util = require('../util');
var Main = require('../app');
var Errors = require('../util/errors');

var Visualization = require('../visuals/visualization').Visualization;
var ParseWaterfall = require('../level/parseWaterfall').ParseWaterfall;
var Level = require('../level').Level;

var Command = require('../models/commandModel').Command;
var GitShim = require('../git/gitShim').GitShim;

var MultiView = require('../views/multiView').MultiView;

var CanvasTerminalHolder = require('../views').CanvasTerminalHolder;
var ConfirmCancelTerminal = require('../views').ConfirmCancelTerminal;
var NextLevelConfirm = require('../views').NextLevelConfirm;
var LevelToolbar = require('../views').LevelToolbar;

var MarkdownPresenter = require('../views/builderViews').MarkdownPresenter;
var MultiViewBuilder = require('../views/builderViews').MultiViewBuilder;
var MarkdownGrabber = require('../views/builderViews').MarkdownGrabber;

var regexMap = {
  'define goal': /^define goal$/,
  'define name': /^define name$/,
  'help builder': /^help builder$/,
  'define start': /^define start$/,
  'edit dialog': /^edit dialog$/,
  'show start': /^show start$/,
  'hide start': /^hide start$/,
  'define hint': /^define hint$/,
  'finish': /^finish$/
};

var parse = util.genParseCommand(regexMap, 'processLevelBuilderCommand');

var LevelBuilder = Level.extend({
  initialize: function(options) {
    options = options || {};
    options.level = options.level || {};

    options.level.startDialog = {
      childViews: require('../dialogs/levelBuilder').dialog
    };
    LevelBuilder.__super__.initialize.apply(this, [options]);

    this.initStartVisualization();
    this.startDialog = undefined;
    this.definedGoal = false;

    // we wont be using this stuff, and its to delete to ensure we overwrite all functions that
    // include that functionality
    delete this.treeCompare;
    delete this.solved;
  },

  initName: function() {
    this.levelToolbar = new LevelToolbar({
      name: 'Level Builder'
    });
  },

  initGoalData: function() {
    // add some default behavior in the beginning
    this.level.goalTreeString = '{"branches":{"master":{"target":"C1","id":"master"},"makeLevel":{"target":"C2","id":"makeLevel"}},"commits":{"C0":{"parents":[],"id":"C0","rootCommit":true},"C1":{"parents":["C0"],"id":"C1"},"C2":{"parents":["C1"],"id":"C2"}},"HEAD":{"target":"makeLevel","id":"HEAD"}}';
    this.level.solutionCommand = 'git checkout -b makeLevel; git commit';
    LevelBuilder.__super__.initGoalData.apply(this, arguments);
  },

  initStartVisualization: function() {
    this.startCanvasHolder = new CanvasTerminalHolder({
      additionalClass: 'startTree',
      text: 'You can hide this window with "hide start"'
    });

    this.startVis = new Visualization({
      el: this.startCanvasHolder.getCanvasLocation(),
      containerElement: this.startCanvasHolder.getCanvasLocation(),
      treeString: this.level.startTree,
      noKeyboardInput: true,
      noClick: true
    });
  },

  startDie: function() {
    this.startCanvasHolder.die();
    this.startVis.die();
  },

  startOffCommand: function() {
    Main.getEventBaton().trigger(
      'commandSubmitted',
      'echo "Get Building!!"'
    );
  },

  initParseWaterfall: function(options) {
    LevelBuilder.__super__.initParseWaterfall.apply(this, [options]);

    this.parseWaterfall.addFirst(
      'parseWaterfall',
      parse
    );
    this.parseWaterfall.addFirst(
      'instantWaterfall',
      this.getInstantCommands()
    );
  },

  buildLevel: function(command, deferred) {
    this.exitLevel();

    setTimeout(function() {
      Main.getSandbox().buildLevel(command, deferred);
    }, this.getAnimationTime() * 1.5);
  },

  getInstantCommands: function() {
    return [
      [/^help$|^\?$/, function() {
        throw new Errors.CommandResult({
          msg: 'You are in a level builder, so multiple forms of ' +
               'help are available. Please select either ' +
               '"help general" or "help builder"'
        });
      }]
    ];
  },

  takeControl: function() {
    Main.getEventBaton().stealBaton('processLevelBuilderCommand', this.processLevelBuilderCommand, this);

    LevelBuilder.__super__.takeControl.apply(this);
  },

  releaseControl: function() {
    Main.getEventBaton().releaseBaton('processLevelBuilderCommand', this.processLevelBuilderCommand, this);

    LevelBuilder.__super__.releaseControl.apply(this);
  },

  showGoal: function() {
    this.startCanvasHolder.slideOut();
    LevelBuilder.__super__.showGoal.apply(this, arguments);
  },

  showStart: function(command, deferred) {
    this.goalCanvasHolder.slideOut();
    this.startCanvasHolder.slideIn();

    setTimeout(function() {
      command.finishWith(deferred);
    }, this.startCanvasHolder.getAnimationTime());
  },

  resetSolution: function() {
    this.gitCommandsIssued = [];
    this.level.solutionCommand = undefined;
  },

  hideStart: function(command, deferred) {
    this.startCanvasHolder.slideOut();

    setTimeout(function() {
      command.finishWith(deferred);
    }, this.startCanvasHolder.getAnimationTime());
  },

  defineStart: function(command, deferred) {
    this.startDie();

    command.addWarning(
      'Defining start point... solution and goal will be overwritten if they were defined earlier'
    );
    this.resetSolution();

    this.level.startTree = this.mainVis.gitEngine.printTree();
    this.mainVis.resetFromThisTreeNow(this.level.startTree);

    this.initStartVisualization();

    this.showStart(command, deferred);
  },

  defineGoal: function(command, deferred) {
    this.goalDie();

    if (!this.gitCommandsIssued.length) {
      command.set('error', new Errors.GitError({
        msg: 'Your solution is empty!! something is amiss'
      }));
      deferred.resolve();
      return;
    }

    this.definedGoal = true;
    this.level.solutionCommand = this.gitCommandsIssued.join(';');
    this.level.goalTreeString = this.mainVis.gitEngine.printTree();
    this.initGoalVisualization();

    this.showGoal(command, deferred);
  },

  defineName: function(command, deferred) {
    this.level.name = prompt('Enter the name for the level');
    if (command) { command.finishWith(deferred); }
  },

  defineHint: function(command, deferred) {
    this.level.hint = prompt('Enter a hint! Or blank if you dont want one');
    if (command) { command.finishWith(deferred); }
  },

  editDialog: function(command, deferred) {
    var whenDoneEditing = Q.defer();
    this.currentBuilder = new MultiViewBuilder({
      multiViewJSON: this.startDialog,
      deferred: whenDoneEditing
    });
    whenDoneEditing.promise
    .then(_.bind(function(levelObj) {
      this.startDialog = levelObj;
    }, this))
    .fail(function() {
      // nothing to do, they dont want to edit it apparently
    })
    .done(function() {
      if (command) {
        command.finishWith(deferred);
      } else {
        deferred.resolve();
      }
    });
  },

  finish: function(command, deferred) {
    if (!this.gitCommandsIssued.length || !this.definedGoal) {
      command.set('error', new Errors.GitError({
        msg: 'Your solution is empty or goal is undefined!'
      }));
      deferred.resolve();
      return;
    }

    while (!this.level.name) {
      this.defineName();
    }

    var masterDeferred = Q.defer();
    var chain = masterDeferred.promise;

    if (this.level.hint === undefined) {
      var askForHintDeferred = Q.defer();
      chain = chain.then(function() {
        return askForHintDeferred.promise;
      });

      // ask for a hint if there is none
      var askForHintView = new ConfirmCancelTerminal({
        markdowns: [
          'You have not specified a hint, would you like to add one?'
        ]
      });
      askForHintView.getPromise()
      .then(_.bind(this.defineHint, this))
      .fail(_.bind(function() {
        this.level.hint = '';
      }, this))
      .done(function() {
        askForHintDeferred.resolve();
      });
    }

    if (this.startDialog === undefined) {
      var askForStartDeferred = Q.defer();
      chain = chain.then(function() {
        return askForStartDeferred.promise;
      });

      var askForStartView = new ConfirmCancelTerminal({
        markdowns: [
          'You have not specified a start dialog, would you like to add one?'
        ]
      });
      askForStartView.getPromise()
      .then(_.bind(function() {
        // oh boy this is complex
        var whenEditedDialog = Q.defer();
        // the undefined here is the command that doesnt need resolving just yet...
        this.editDialog(undefined, whenEditedDialog);
        return whenEditedDialog.promise;
      }, this))
      .fail(function() {
        // if they dont want to edit the start dialog, do nothing
      })
      .done(function() {
        askForStartDeferred.resolve();
      });
    }

    chain = chain.done(_.bind(function() {
      // ok great! lets just give them the goods
      new MarkdownPresenter({
        fillerText: JSON.stringify(this.getExportObj(), null, 2),
        previewText: 'Here is the JSON for this level! Share it with someone or send it to me on Github!'
      });
      command.finishWith(deferred);
    }, this));

    masterDeferred.resolve();
  },

  getExportObj: function() {
    var compiledLevel = _.extend(
      {},
      this.level
    );
    // the start dialog now is just our help intro thing
    delete compiledLevel.startDialog;
    if (this.startDialog) {
      compiledLevel.startDialog  = this.startDialog;
    }
    return compiledLevel;
  },

  processLevelBuilderCommand: function(command, deferred) {
    var methodMap = {
      'define goal': this.defineGoal,
      'define start': this.defineStart,
      'show start': this.showStart,
      'hide start': this.hideStart,
      'finish': this.finish,
      'define hint': this.defineHint,
      'edit dialog': this.editDialog,
      'help builder': LevelBuilder.__super__.startDialog
    };
    if (!methodMap[command.get('method')]) {
      throw new Error('woah we dont support that method yet');
    }

    methodMap[command.get('method')].apply(this, arguments);
  },

  afterCommandDefer: function(defer, command) {
    // we dont need to compare against the goal anymore
    defer.resolve();
  },

  die: function() {
    this.startDie();

    LevelBuilder.__super__.die.apply(this, arguments);

    delete this.startVis;
    delete this.startCanvasHolder;
  }
});

exports.LevelBuilder = LevelBuilder;
exports.regexMap = regexMap;
