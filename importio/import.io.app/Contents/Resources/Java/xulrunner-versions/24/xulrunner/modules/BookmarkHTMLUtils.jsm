/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file works on the old-style "bookmarks.html" file.  It includes
 * functions to import and export existing bookmarks to this file format.
 *
 * Format
 * ------
 *
 * Primary heading := h1
 *   Old version used this to set attributes on the bookmarks RDF root, such
 *   as the last modified date. We only use H1 to check for the attribute
 *   PLACES_ROOT, which tells us that this hierarchy root is the places root.
 *   For backwards compatibility, if we don't find this, we assume that the
 *   hierarchy is rooted at the bookmarks menu.
 * Heading := any heading other than h1
 *   Old version used this to set attributes on the current container. We only
 *   care about the content of the heading container, which contains the title
 *   of the bookmark container.
 * Bookmark := a
 *   HREF is the destination of the bookmark
 *   FEEDURL is the URI of the RSS feed if this is a livemark.
 *   LAST_CHARSET is stored as an annotation so that the next time we go to
 *     that page we remember the user's preference.
 *   WEB_PANEL is set to "true" if the bookmark should be loaded in the sidebar.
 *   ICON will be stored in the favicon service
 *   ICON_URI is new for places bookmarks.html, it refers to the original
 *     URI of the favicon so we don't have to make up favicon URLs.
 *   Text of the <a> container is the name of the bookmark
 *   Ignored: LAST_VISIT, ID (writing out non-RDF IDs can confuse Firefox 2)
 * Bookmark comment := dd
 *   This affects the previosly added bookmark
 * Separator := hr
 *   Insert a separator into the current container
 * The folder hierarchy is defined by <dl>/<ul>/<menu> (the old importing code
 *     handles all these cases, when we write, use <dl>).
 *
 * Overall design
 * --------------
 *
 * We need to emulate a recursive parser. A "Bookmark import frame" is created
 * corresponding to each folder we encounter. These are arranged in a stack,
 * and contain all the state we need to keep track of.
 *
 * A frame is created when we find a heading, which defines a new container.
 * The frame also keeps track of the nesting of <DL>s, (in well-formed
 * bookmarks files, these will have a 1-1 correspondence with frames, but we
 * try to be a little more flexible here). When the nesting count decreases
 * to 0, then we know a frame is complete and to pop back to the previous
 * frame.
 *
 * Note that a lot of things happen when tags are CLOSED because we need to
 * get the text from the content of the tag. For example, link and heading tags
 * both require the content (= title) before actually creating it.
 */

this.EXPORTED_SYMBOLS = [ "BookmarkHTMLUtils" ];

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/PlacesUtils.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/commonjs/sdk/core/promise.js");

const Container_Normal = 0;
const Container_Toolbar = 1;
const Container_Menu = 2;
const Container_Unfiled = 3;
const Container_Places = 4;

const LOAD_IN_SIDEBAR_ANNO = "bookmarkProperties/loadInSidebar";
const DESCRIPTION_ANNO = "bookmarkProperties/description";

const MICROSEC_PER_SEC = 1000000;

const EXPORT_INDENT = "    "; // four spaces

//@line 90 "/Users/mjgp2/gecko-dev/toolkit/components/places/BookmarkHTMLUtils.jsm"
const EXPORT_NEWLINE = "\n";
//@line 92 "/Users/mjgp2/gecko-dev/toolkit/components/places/BookmarkHTMLUtils.jsm"

let serialNumber = 0; // for favicons

function base64EncodeString(aString) {
  let stream = Cc["@mozilla.org/io/string-input-stream;1"]
                 .createInstance(Ci.nsIStringInputStream);
  stream.setData(aString, aString.length);
  let encoder = Cc["@mozilla.org/scriptablebase64encoder;1"]
                  .createInstance(Ci.nsIScriptableBase64Encoder);
  return encoder.encodeToString(stream, aString.length);
}

this.BookmarkHTMLUtils = Object.freeze({
  /**
   * Loads the current bookmarks hierarchy from a "bookmarks.html" file.
   *
   * @param aUrlString
   *        String containing the "file:" URI for the existing "bookmarks.html"
   *        file to be loaded.
   * @param aInitialImport
   *        Whether this is the initial import executed on a new profile.
   *
   * @return {Promise}
   * @resolves When the new bookmarks have been created.
   * @rejects JavaScript exception.
   */
  importFromURL: function BHU_importFromURL(aUrlString, aInitialImport) {
    let importer = new BookmarkImporter(aInitialImport);
    return importer.importFromURL(aUrlString);
  },

  /**
   * Loads the current bookmarks hierarchy from a "bookmarks.html" file.
   *
   * @param aLocalFile
   *        nsIFile for the existing "bookmarks.html" file to be loaded.
   * @param aInitialImport
   *        Whether this is the initial import executed on a new profile.
   *
   * @return {Promise}
   * @resolves When the new bookmarks have been created.
   * @rejects JavaScript exception.
   */
  importFromFile: function BHU_importFromFile(aLocalFile, aInitialImport) {
    let importer = new BookmarkImporter(aInitialImport);
    return importer.importFromURL(NetUtil.newURI(aLocalFile).spec);
  },

  /**
   * Saves the current bookmarks hierarchy to a "bookmarks.html" file.
   *
   * @param aLocalFile
   *        nsIFile for the "bookmarks.html" file to be created.
   *
   * @return {Promise}
   * @resolves When the file has been created.
   * @rejects JavaScript exception.
   */
  exportToFile: function BHU_exportToFile(aLocalFile) {
    let exporter = new BookmarkExporter();
    return exporter.exportToFile(aLocalFile);
  },
});

function Frame(aFrameId) {
  this.containerId = aFrameId;

  /**
   * How many <dl>s have been nested. Each frame/container should start
   * with a heading, and is then followed by a <dl>, <ul>, or <menu>. When
   * that list is complete, then it is the end of this container and we need
   * to pop back up one level for new items. If we never get an open tag for
   * one of these things, we should assume that the container is empty and
   * that things we find should be siblings of it. Normally, these <dl>s won't
   * be nested so this will be 0 or 1.
   */
  this.containerNesting = 0;

  /**
   * when we find a heading tag, it actually affects the title of the NEXT
   * container in the list. This stores that heading tag and whether it was
   * special. 'consumeHeading' resets this._
   */
  this.lastContainerType = Container_Normal;

  /**
   * this contains the text from the last begin tag until now. It is reset
   * at every begin tag. We can check it when we see a </a>, or </h3>
   * to see what the text content of that node should be.
   */
  this.previousText = "";

  /**
   * true when we hit a <dd>, which contains the description for the preceding
   * <a> tag. We can't just check for </dd> like we can for </a> or </h3>
   * because if there is a sub-folder, it is actually a child of the <dd>
   * because the tag is never explicitly closed. If this is true and we see a
   * new open tag, that means to commit the description to the previous
   * bookmark.
   *
   * Additional weirdness happens when the previous <dt> tag contains a <h3>:
   * this means there is a new folder with the given description, and whose
   * children are contained in the following <dl> list.
   *
   * This is handled in openContainer(), which commits previous text if
   * necessary.
   */
  this.inDescription = false;

  /**
   * contains the URL of the previous bookmark created. This is used so that
   * when we encounter a <dd>, we know what bookmark to associate the text with.
   * This is cleared whenever we hit a <h3>, so that we know NOT to save this
   * with a bookmark, but to keep it until 
   */
  this.previousLink = null; // nsIURI

  /**
   * contains the URL of the previous livemark, so that when the link ends,
   * and the livemark title is known, we can create it.
   */
  this.previousFeed = null; // nsIURI

  /**
   * Contains the id of an imported, or newly created bookmark.
   */
  this.previousId = 0;

  /**
   * Contains the date-added and last-modified-date of an imported item.
   * Used to override the values set by insertBookmark, createFolder, etc.
   */
  this.previousDateAdded = 0;
  this.previousLastModifiedDate = 0;
}

function BookmarkImporter(aInitialImport) {
  this._isImportDefaults = aInitialImport;
  this._frames = new Array();
  this._frames.push(new Frame(PlacesUtils.bookmarksMenuFolderId));
}

BookmarkImporter.prototype = {

  _safeTrim: function safeTrim(aStr) {
    return aStr ? aStr.trim() : aStr;
  },

  get _curFrame() {
    return this._frames[this._frames.length - 1];
  },

  get _previousFrame() {
    return this._frames[this._frames.length - 2];
  },

  /**
   * This is called when there is a new folder found. The folder takes the
   * name from the previous frame's heading.
   */
  _newFrame: function newFrame() {
    let containerId = -1;
    let frame = this._curFrame;
    let containerTitle = frame.previousText;
    frame.previousText = "";
    let containerType = frame.lastContainerType;

    switch (containerType) {
      case Container_Normal:
        // append a new folder
        containerId = 
          PlacesUtils.bookmarks.createFolder(frame.containerId,
                                             containerTitle,
                                             PlacesUtils.bookmarks.DEFAULT_INDEX);
        break;
      case Container_Places:
        containerId = PlacesUtils.placesRootId;
        break;
      case Container_Menu:
        containerId = PlacesUtils.bookmarksMenuFolderId;
        break;
      case Container_Unfiled:
        containerId = PlacesUtils.unfiledBookmarksFolderId;
        break;
      case Container_Toolbar:
        containerId = PlacesUtils.toolbarFolderId;
        break;
      default:
        // NOT REACHED
        throw new Error("Unreached");
    }

    if (frame.previousDateAdded > 0) {
      try {
        PlacesUtils.bookmarks.setItemDateAdded(containerId, frame.previousDateAdded);
      } catch(e) {
      }
      frame.previousDateAdded = 0;
    }
    if (frame.previousLastModifiedDate > 0) {
      try {
        PlacesUtils.bookmarks.setItemLastModified(containerId, frame.previousLastModifiedDate);
      } catch(e) {
      }
      // don't clear last-modified, in case there's a description
    }

    frame.previousId = containerId;

    this._frames.push(new Frame(containerId));
  },

  /**
   * Handles <hr> as a separator.
   *
   * @note Separators may have a title in old html files, though Places dropped
   *       support for them.
   *       We also don't import ADD_DATE or LAST_MODIFIED for separators because
   *       pre-Places bookmarks did not support them.
   */
  _handleSeparator: function handleSeparator(aElt) {
    let frame = this._curFrame;
    try {
      frame.previousId =
        PlacesUtils.bookmarks.insertSeparator(frame.containerId,
                                              PlacesUtils.bookmarks.DEFAULT_INDEX);
    } catch(e) {}
  },

  /**
   * Handles <H1>. We check for the attribute PLACES_ROOT and reset the
   * container id if it's found. Otherwise, the default bookmark menu
   * root is assumed and imported things will go into the bookmarks menu.
   */
  _handleHead1Begin: function handleHead1Begin(aElt) {
    if (this._frames.length > 1) {
      return;
    }
    if (aElt.hasAttribute("places_root")) {
      this._curFrame.containerId = PlacesUtils.placesRootId;
    }
  },

  /**
   * Called for h2,h3,h4,h5,h6. This just stores the correct information in
   * the current frame; the actual new frame corresponding to the container
   * associated with the heading will be created when the tag has been closed
   * and we know the title (we don't know to create a new folder or to merge
   * with an existing one until we have the title).
   */
  _handleHeadBegin: function handleHeadBegin(aElt) {
    let frame = this._curFrame;

    // after a heading, a previous bookmark is not applicable (for example, for
    // the descriptions contained in a <dd>). Neither is any previous head type
    frame.previousLink = null;
    frame.lastContainerType = Container_Normal;

    // It is syntactically possible for a heading to appear after another heading
    // but before the <dl> that encloses that folder's contents.  This should not
    // happen in practice, as the file will contain "<dl></dl>" sequence for
    // empty containers.
    //
    // Just to be on the safe side, if we encounter
    //   <h3>FOO</h3>
    //   <h3>BAR</h3>
    //   <dl>...content 1...</dl>
    //   <dl>...content 2...</dl>
    // we'll pop the stack when we find the h3 for BAR, treating that as an
    // implicit ending of the FOO container. The output will be FOO and BAR as
    // siblings. If there's another <dl> following (as in "content 2"), those
    // items will be treated as further siblings of FOO and BAR
    // This special frame popping business, of course, only happens when our
    // frame array has more than one element so we can avoid situations where
    // we don't have a frame to parse into anymore.
    if (frame.containerNesting == 0 && this._frames.length > 1) {
      this._frames.pop();
    }

    // We have to check for some attributes to see if this is a "special"
    // folder, which will have different creation rules when the end tag is
    // processed.
    if (aElt.hasAttribute("personal_toolbar_folder")) {
      if (this._isImportDefaults) {
        frame.lastContainerType = Container_Toolbar;
      }
    } else if (aElt.hasAttribute("bookmarks_menu")) {
      if (this._isImportDefaults) {
        frame.lastContainerType = Container_Menu;
      }
    } else if (aElt.hasAttribute("unfiled_bookmarks_folder")) {
      if (this._isImportDefaults) {
        frame.lastContainerType = Container_Unfiled;
      }
    } else if (aElt.hasAttribute("places_root")) {
      if (this._isImportDefaults) {
        frame.lastContainerType = Container_Places;
      }
    } else {
      let addDate = aElt.getAttribute("add_date");
      if (addDate) {
        frame.previousDateAdded =
          this._convertImportedDateToInternalDate(addDate);
      }
      let modDate = aElt.getAttribute("last_modified");
      if (modDate) {
        frame.previousLastModifiedDate =
          this._convertImportedDateToInternalDate(modDate);
      }
    }
    this._curFrame.previousText = "";
  },

  /*
   * Handles "<a" tags by creating a new bookmark. The title of the bookmark
   * will be the text content, which will be stuffed in previousText for us
   * and which will be saved by handleLinkEnd
   */
  _handleLinkBegin: function handleLinkBegin(aElt) {
    let frame = this._curFrame;

    // Make sure that the feed URIs from previous frames are emptied.
    frame.previousFeed = null;
    // Make sure that the bookmark id from previous frames are emptied.
    frame.previousId = 0;
    // mPreviousText will hold link text, clear it.
    frame.previousText = "";

    // Get the attributes we care about.
    let href = this._safeTrim(aElt.getAttribute("href"));
    let feedUrl = this._safeTrim(aElt.getAttribute("feedurl"));
    let icon = this._safeTrim(aElt.getAttribute("icon"));
    let iconUri = this._safeTrim(aElt.getAttribute("icon_uri"));
    let lastCharset = this._safeTrim(aElt.getAttribute("last_charset"));
    let keyword = this._safeTrim(aElt.getAttribute("shortcuturl"));
    let postData = this._safeTrim(aElt.getAttribute("post_data"));
    let webPanel = this._safeTrim(aElt.getAttribute("web_panel"));
    let micsumGenURI = this._safeTrim(aElt.getAttribute("micsum_gen_uri"));
    let generatedTitle = this._safeTrim(aElt.getAttribute("generated_title"));
    let dateAdded = this._safeTrim(aElt.getAttribute("add_date"));
    let lastModified = this._safeTrim(aElt.getAttribute("last_modified"));

    // For feeds, get the feed URL.  If it is invalid, mPreviousFeed will be
    // NULL and we'll create it as a normal bookmark.
    if (feedUrl) {
      frame.previousFeed = NetUtil.newURI(feedUrl);
    }

    // Ignore <a> tags that have no href.
    if (href) {
      // Save the address if it's valid.  Note that we ignore errors if this is a
      // feed since href is optional for them.
      try {
        frame.previousLink = NetUtil.newURI(href);
      } catch(e) {
        if (!frame.previousFeed) {
          frame.previousLink = null;
          return;
        }
      }
    } else {
      frame.previousLink = null;
      // The exception is for feeds, where the href is an optional component
      // indicating the source web site.
      if (!frame.previousFeed) {
        return;
      }
    }

    // Save bookmark's last modified date.
    if (lastModified) {
      frame.previousLastModifiedDate =
        this._convertImportedDateToInternalDate(lastModified);
    }

    // If this is a live bookmark, we will handle it in HandleLinkEnd(), so we
    // can skip bookmark creation.
    if (frame.previousFeed) {
      return;
    }

    // Create the bookmark.  The title is unknown for now, we will set it later.
    try {
      frame.previousId =
        PlacesUtils.bookmarks.insertBookmark(frame.containerId,
                                             frame.previousLink,
                                             PlacesUtils.bookmarks.DEFAULT_INDEX,
                                             "");
    } catch(e) {
      return;
    }

    // Set the date added value, if we have it.
    if (dateAdded) {
      try {
        PlacesUtils.bookmarks.setItemDateAdded(frame.previousId,
          this._convertImportedDateToInternalDate(dateAdded));
      } catch(e) {
      }
    }

    // Save the favicon.
    if (icon || iconUri) {
      let iconUriObject;
      try {
        iconUriObject = NetUtil.newURI(iconUri);
      } catch(e) {
      }
      if (icon || iconUriObject) {
        try {
          this._setFaviconForURI(frame.previousLink, iconUriObject, icon);
        } catch(e) {
        }
      }
    }

    // Save the keyword.
    if (keyword) {
      try {
        PlacesUtils.bookmarks.setKeywordForBookmark(frame.previousId, keyword);
        if (postData) {
          PlacesUtils.annotations.setItemAnnotation(frame.previousId,
                                                    PlacesUtils.POST_DATA_ANNO,
                                                    postData,
                                                    0,
                                                    PlacesUtils.annotations.EXPIRE_NEVER);
        }
      } catch(e) {
      }
    }

    // Set load-in-sidebar annotation for the bookmark.
    if (webPanel && webPanel.toLowerCase() == "true") {
      try {
        PlacesUtils.annotations.setItemAnnotation(frame.previousId,
                                                  LOAD_IN_SIDEBAR_ANNO,
                                                  1,
                                                  0,
                                                  PlacesUtils.annotations.EXPIRE_NEVER);
      } catch(e) {
      }
    }

    // Import last charset.
    if (lastCharset) {
      PlacesUtils.setCharsetForURI(frame.previousLink, lastCharset);
    }
  },

  _handleContainerBegin: function handleContainerBegin() {
    this._curFrame.containerNesting++;
  },

  /**
   * Our "indent" count has decreased, and when we hit 0 that means that this
   * container is complete and we need to pop back to the outer frame. Never
   * pop the toplevel frame
   */
  _handleContainerEnd: function handleContainerEnd() {
    let frame = this._curFrame;
    if (frame.containerNesting > 0)
      frame.containerNesting --;
    if (this._frames.length > 1 && frame.containerNesting == 0) {
      // we also need to re-set the imported last-modified date here. Otherwise
      // the addition of items will override the imported field.
      let prevFrame = this._previousFrame;
      if (prevFrame.previousLastModifiedDate > 0) {
        PlacesUtils.bookmarks.setItemLastModified(frame.containerId,
                                                  prevFrame.previousLastModifiedDate);
      }
      this._frames.pop();
    }
  },

  /**
   * Creates the new frame for this heading now that we know the name of the
   * container (tokens since the heading open tag will have been placed in
   * previousText).
   */
  _handleHeadEnd: function handleHeadEnd() {
    this._newFrame();
  },

  /**
   * Saves the title for the given bookmark.
   */
  _handleLinkEnd: function handleLinkEnd() {
    let frame = this._curFrame;
    frame.previousText = frame.previousText.trim();

    try {
      if (frame.previousFeed) {
        // The is a live bookmark.  We create it here since in HandleLinkBegin we
        // don't know the title.
        PlacesUtils.livemarks.addLivemark({
          "title": frame.previousText,
          "parentId": frame.containerId,
          "index": PlacesUtils.bookmarks.DEFAULT_INDEX,
          "feedURI": frame.previousFeed,
          "siteURI": frame.previousLink,
        });
      } else if (frame.previousLink) {
        // This is a common bookmark.
        PlacesUtils.bookmarks.setItemTitle(frame.previousId,
                                           frame.previousText);
      }
    } catch(e) {
    }


    // Set last modified date as the last change.
    if (frame.previousId > 0 && frame.previousLastModifiedDate > 0) {
      try {
        PlacesUtils.bookmarks.setItemLastModified(frame.previousId,
                                                  frame.previousLastModifiedDate);
      } catch(e) {
      }
      // Note: don't clear previousLastModifiedDate, because if this item has a
      // description, we'll need to set it again.
    }

    frame.previousText = "";

  },

  _openContainer: function openContainer(aElt) {
    if (aElt.namespaceURI != "http://www.w3.org/1999/xhtml") {
      return;
    }
    switch(aElt.localName) {
      case "h1":
        this._handleHead1Begin(aElt);
        break;
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        this._handleHeadBegin(aElt);
        break;
      case "a":
        this._handleLinkBegin(aElt);
        break;
      case "dl":
      case "ul":
      case "menu":
        this._handleContainerBegin();
        break;
      case "dd":
        this._curFrame.inDescription = true;
        break;
      case "hr":
        this._handleSeparator(aElt);
        break;
    }
  },

  _closeContainer: function closeContainer(aElt) {
    let frame = this._curFrame;

    // see the comment for the definition of inDescription. Basically, we commit
    // any text in previousText to the description of the node/folder if there
    // is any.
    if (frame.inDescription) {
      // NOTE ES5 trim trims more than the previous C++ trim.
      frame.previousText = frame.previousText.trim(); // important
      if (frame.previousText) {

        let itemId = !frame.previousLink ? frame.containerId
                                         : frame.previousId;

        try {
          if (!PlacesUtils.annotations.itemHasAnnotation(itemId, DESCRIPTION_ANNO)) {
            PlacesUtils.annotations.setItemAnnotation(itemId,
                                                      DESCRIPTION_ANNO,
                                                      frame.previousText,
                                                      0,
                                                      PlacesUtils.annotations.EXPIRE_NEVER);
          }
        } catch(e) {
        }
        frame.previousText = "";

        // Set last-modified a 2nd time for all items with descriptions
        // we need to set last-modified as the *last* step in processing 
        // any item type in the bookmarks.html file, so that we do
        // not overwrite the imported value. for items without descriptions, 
        // setting this value after setting the item title is that 
        // last point at which we can save this value before it gets reset.
        // for items with descriptions, it must set after that point.
        // however, at the point at which we set the title, there's no way 
        // to determine if there will be a description following, 
        // so we need to set the last-modified-date at both places.

        let lastModified;
        if (!frame.previousLink) {
          lastModified = this._previousFrame.previousLastModifiedDate;
        } else {
          lastModified = frame.previousLastModifiedDate;
        }

        if (itemId > 0 && lastModified > 0) {
          PlacesUtils.bookmarks.setItemLastModified(itemId, lastModified);
        }
      }
      frame.inDescription = false;
    }

    if (aElt.namespaceURI != "http://www.w3.org/1999/xhtml") {
      return;
    }
    switch(aElt.localName) {
      case "dl":
      case "ul":
      case "menu":
        this._handleContainerEnd();
        break;
      case "dt":
        break;
      case "h1":
        // ignore
        break;
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        this._handleHeadEnd();
        break;
      case "a":
        this._handleLinkEnd();
        break;
      default:
        break;
    }
  },

  _appendText: function appendText(str) {
    this._curFrame.previousText += str;
  },

  /**
   * data is a string that is a data URI for the favicon. Our job is to
   * decode it and store it in the favicon service.
   *
   * When aIconURI is non-null, we will use that as the URI of the favicon
   * when storing in the favicon service.
   *
   * When aIconURI is null, we have to make up a URI for this favicon so that
   * it can be stored in the service. The real one will be set the next time
   * the user visits the page. Our made up one should get expired when the
   * page no longer references it.
   */
  _setFaviconForURI: function setFaviconForURI(aPageURI, aIconURI, aData) {
    // if the input favicon URI is a chrome: URI, then we just save it and don't
    // worry about data
    if (aIconURI) {
      if (aIconURI.schemeIs("chrome")) {
        PlacesUtils.favicons.setAndFetchFaviconForPage(aPageURI, aIconURI,
                                                       false,
                                                       PlacesUtils.favicons.FAVICON_LOAD_NON_PRIVATE);
        return;
      }
    }

    // some bookmarks have placeholder URIs that contain just "data:"
    // ignore these
    if (aData.length <= 5) {
      return;
    }

    let faviconURI;
    if (aIconURI) {
      faviconURI = aIconURI;
    } else {
      // Make up a favicon URI for this page.  Later, we'll make sure that this
      // favicon URI is always associated with local favicon data, so that we
      // don't load this URI from the network.
      let faviconSpec = "http://www.mozilla.org/2005/made-up-favicon/"
                      + serialNumber
                      + "-"
                      + new Date().getTime();
      faviconURI = NetUtil.newURI(faviconSpec);
      serialNumber++;
    }

    // This could fail if the favicon is bigger than defined limit, in such a
    // case neither the favicon URI nor the favicon data will be saved.  If the
    // bookmark is visited again later, the URI and data will be fetched.
    PlacesUtils.favicons.replaceFaviconDataFromDataURL(faviconURI, aData);
    PlacesUtils.favicons.setAndFetchFaviconForPage(aPageURI, faviconURI, false, PlacesUtils.favicons.FAVICON_LOAD_NON_PRIVATE);
  },

  /**
   * Converts a string date in seconds to an int date in microseconds
   */
  _convertImportedDateToInternalDate: function convertImportedDateToInternalDate(aDate) {
    if (aDate && !isNaN(aDate)) {
      return parseInt(aDate) * 1000000; // in bookmarks.html this value is in seconds, not microseconds
    } else {
      return Date.now();
    }
  },

  runBatched: function runBatched(aDoc) {
    if (!aDoc) {
      return;
    }

    if (this._isImportDefaults) {
      PlacesUtils.bookmarks.removeFolderChildren(PlacesUtils.bookmarksMenuFolderId);
      PlacesUtils.bookmarks.removeFolderChildren(PlacesUtils.toolbarFolderId);
      PlacesUtils.bookmarks.removeFolderChildren(PlacesUtils.unfiledBookmarksFolderId);
    }

    let current = aDoc;
    let next;
    for (;;) {
      switch (current.nodeType) {
        case Ci.nsIDOMNode.ELEMENT_NODE:
          this._openContainer(current);
          break;
        case Ci.nsIDOMNode.TEXT_NODE:
          this._appendText(current.data);
          break;
      }
      if ((next = current.firstChild)) {
        current = next;
        continue;
      }
      for (;;) {
        if (current.nodeType == Ci.nsIDOMNode.ELEMENT_NODE) {
          this._closeContainer(current);
        }
        if (current == aDoc) {
          return;
        }
        if ((next = current.nextSibling)) {
          current = next;
          break;
        }
        current = current.parentNode;
      }
    }
  },

  _walkTreeForImport: function walkTreeForImport(aDoc) {
    PlacesUtils.bookmarks.runInBatchMode(this, aDoc);
  },

  _notifyObservers: function notifyObservers(topic) {
    Services.obs.notifyObservers(null,
                                 topic,
                                 this._isImportDefaults ? "html-initial"
                                                        : "html");
  },

  importFromURL: function importFromURL(aUrlString, aCallback) {
    let deferred = Promise.defer();
    let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(Ci.nsIXMLHttpRequest);
    xhr.onload = (function onload() {
      try {
        this._walkTreeForImport(xhr.responseXML);
        this._notifyObservers(PlacesUtils.TOPIC_BOOKMARKS_RESTORE_SUCCESS);
        deferred.resolve();
      } catch(e) {
        this._notifyObservers(PlacesUtils.TOPIC_BOOKMARKS_RESTORE_FAILED);
        deferred.reject(e);
        throw e;
      }
    }).bind(this);
    xhr.onabort = xhr.onerror = xhr.ontimeout = (function handleFail() {
      this._notifyObservers(PlacesUtils.TOPIC_BOOKMARKS_RESTORE_FAILED);
      deferred.reject(new Error("xmlhttprequest failed"));
    }).bind(this);
    this._notifyObservers(PlacesUtils.TOPIC_BOOKMARKS_RESTORE_BEGIN);
    try {
      xhr.open("GET", aUrlString);
      xhr.responseType = "document";
      xhr.overrideMimeType("text/html");
      xhr.send();
    } catch (e) {
      this._notifyObservers(PlacesUtils.TOPIC_BOOKMARKS_RESTORE_FAILED);
      deferred.reject(e);
    }
    return deferred.promise;
  },

};

function BookmarkExporter() { }

BookmarkExporter.prototype = {

  /**
   * Provides HTML escaping for use in HTML attributes and body of the bookmarks
   * file, compatible with the old bookmarks system.
   */
  escapeHtml: function escapeHtml(aText) {
    return (aText || "").replace("&", "&amp;", "g")
                        .replace("<", "&lt;", "g")
                        .replace(">", "&gt;", "g")
                        .replace("\"", "&quot;", "g")
                        .replace("'", "&#39;", "g");
  },

  /**
   * Provides URL escaping for use in HTML attributes of the bookmarks file,
   * compatible with the old bookmarks system.
   */
  escapeUrl: function escapeUrl(aText) {
    return (aText || "").replace("\"", "%22", "g");
  },

  exportToFile: function exportToFile(aLocalFile) {
    return Task.spawn(this._doExportToFile(aLocalFile));
  },

  _doExportToFile: function doExportToFile(aLocalFile) {
    // Create a file that can be accessed by the current user only.
    let safeFileOut = Cc["@mozilla.org/network/safe-file-output-stream;1"]
                      .createInstance(Ci.nsIFileOutputStream);
    safeFileOut.init(aLocalFile,
                     FileUtils.MODE_WRONLY | FileUtils.MODE_CREATE
                                           | FileUtils.MODE_TRUNCATE,
                     parseInt("0600", 8), 0);
    try {
      // We need a buffered output stream for performance.  See bug 202477.
      let bufferedOut = Cc["@mozilla.org/network/buffered-output-stream;1"]
                        .createInstance(Ci.nsIBufferedOutputStream);
      bufferedOut.init(safeFileOut, 4096);
      try {
        // Write bookmarks in UTF-8.
        this._converterOut = Cc["@mozilla.org/intl/converter-output-stream;1"]
                             .createInstance(Ci.nsIConverterOutputStream);
        this._converterOut.init(bufferedOut, "utf-8", 0, 0);
        try {
          yield this._doExport();

          // Flush the buffer and retain the target file on success only.
          bufferedOut.QueryInterface(Ci.nsISafeOutputStream).finish();
        } finally {
          this._converterOut.close();
          this._converterOut = null;
        }
      } finally {
        bufferedOut.close();
      }
    } finally {
      safeFileOut.close();
    }
  },

  _converterOut: null,

  _write: function write(aText) {
    this._converterOut.writeString(aText || "");
  },

  _writeLine: function writeLine(aText) {
    this._write(aText + EXPORT_NEWLINE);
  },

  _doExport: function doExport() {
    this._writeLine("<!DOCTYPE NETSCAPE-Bookmark-file-1>");
    this._writeLine("<!-- This is an automatically generated file.");
    this._writeLine("     It will be read and overwritten.");
    this._writeLine("     DO NOT EDIT! -->");
    this._writeLine("<META HTTP-EQUIV=\"Content-Type\"" +
                    " CONTENT=\"text/html; charset=UTF-8\">");
    this._writeLine("<TITLE>Bookmarks</TITLE>");

    // Write the Bookmarks Menu as the outer container.
    let root = PlacesUtils.getFolderContents(
                                    PlacesUtils.bookmarksMenuFolderId).root;
    try {
      this._writeLine("<H1>" + this.escapeHtml(root.title) + "</H1>");
      this._writeLine("");
      this._writeLine("<DL><p>");
      yield this._writeContainerContents(root, "");
    } finally {
      root.containerOpen = false;
    }

    // Write the Bookmarks Toolbar as a child item for backwards compatibility.
    root = PlacesUtils.getFolderContents(PlacesUtils.toolbarFolderId).root;
    try {
      if (root.childCount > 0) {
        yield this._writeContainer(root, EXPORT_INDENT);
      }
    } finally {
      root.containerOpen = false;
    }

    // Write the Unfiled Bookmarks as a child item for backwards compatibility.
    root = PlacesUtils.getFolderContents(
                                PlacesUtils.unfiledBookmarksFolderId).root;
    try {
      if (root.childCount > 0) {
        yield this._writeContainer(root, EXPORT_INDENT);
      }
    } finally {
      root.containerOpen = false;
    }

    this._writeLine("</DL><p>");
  },

  _writeContainer: function writeContainer(aItem, aIndent) {
    this._write(aIndent + "<DT><H3");
    yield this._writeDateAttributes(aItem);

    if (aItem.itemId == PlacesUtils.placesRootId) {
      this._write(" PLACES_ROOT=\"true\"");
    } else if (aItem.itemId == PlacesUtils.bookmarksMenuFolderId) {
      this._write(" BOOKMARKS_MENU=\"true\"");
    } else if (aItem.itemId == PlacesUtils.unfiledBookmarksFolderId) {
      this._write(" UNFILED_BOOKMARKS_FOLDER=\"true\"");
    } else if (aItem.itemId == PlacesUtils.toolbarFolderId) {
      this._write(" PERSONAL_TOOLBAR_FOLDER=\"true\"");
    }

    this._writeLine(">" + this.escapeHtml(aItem.title) + "</H3>");
    yield this._writeDescription(aItem);
    this._writeLine(aIndent + "<DL><p>");
    yield this._writeContainerContents(aItem, aIndent);
    this._writeLine(aIndent + "</DL><p>");
  },

  _writeContainerContents: function writeContainerContents(aItem, aIndent) {
    let localIndent = aIndent + EXPORT_INDENT;

    for (let i = 0; i < aItem.childCount; ++i) {
      let child = aItem.getChild(i);
      if (child.type == Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER) {
        // Since the livemarks service is asynchronous, use the annotations
        // service to get the information for now.
        if (PlacesUtils.annotations
                       .itemHasAnnotation(child.itemId,
                                          PlacesUtils.LMANNO_FEEDURI)) {
          yield this._writeLivemark(child, localIndent);
        } else {
          // This is a normal folder, open it.
          PlacesUtils.asContainer(child).containerOpen = true;
          try {
            yield this._writeContainer(child, localIndent);
          } finally {
            child.containerOpen = false;
          }
        }
      } else if (child.type == Ci.nsINavHistoryResultNode.RESULT_TYPE_SEPARATOR) {
        yield this._writeSeparator(child, localIndent);
      } else {
        yield this._writeItem(child, localIndent);
      }
    }
  },

  _writeSeparator: function writeSeparator(aItem, aIndent) {
    this._write(aIndent + "<HR");

    // We keep exporting separator titles, but don't support them anymore.
    let title = null;
    try {
      title = PlacesUtils.bookmarks.getItemTitle(aItem.itemId);
    } catch (ex) { }

    if (title) {
      this._write(" NAME=\"" + this.escapeHtml(title) + "\"");
    }

    this._write(">");
  },

  _writeLivemark: function writeLivemark(aItem, aIndent) {
    this._write(aIndent + "<DT><A");
    let feedSpec = PlacesUtils.annotations
                              .getItemAnnotation(aItem.itemId,
                                                 PlacesUtils.LMANNO_FEEDURI);
    this._write(" FEEDURL=\"" + this.escapeUrl(feedSpec) + "\"");

    // The site URI is optional.
    try {
      let siteSpec = PlacesUtils.annotations
                                .getItemAnnotation(aItem.itemId,
                                                   PlacesUtils.LMANNO_SITEURI);
      if (siteSpec) {
        this._write(" HREF=\"" + this.escapeUrl(siteSpec) + "\"");
      }
    } catch (ex) { }

    this._writeLine(">" + this.escapeHtml(aItem.title) + "</A>");
    yield this._writeDescription(aItem);
  },

  _writeItem: function writeItem(aItem, aIndent) {
    let itemUri = null;
    try {
      itemUri = NetUtil.newURI(aItem.uri);
    } catch (ex) {
      // If the item URI is invalid, skip the item instead of failing later.
      return;
    }

    this._write(aIndent + "<DT><A HREF=\"" + this.escapeUrl(aItem.uri) + "\"");
    yield this._writeDateAttributes(aItem);
    yield this._writeFaviconAttribute(itemUri);

    let keyword = PlacesUtils.bookmarks.getKeywordForBookmark(aItem.itemId);
    if (keyword) {
      this._write(" SHORTCUTURL=\"" + this.escapeHtml(keyword) + "\"");
    }

    if (PlacesUtils.annotations.itemHasAnnotation(aItem.itemId,
                                                  PlacesUtils.POST_DATA_ANNO)) {
      let postData = PlacesUtils.annotations
                                .getItemAnnotation(aItem.itemId,
                                                   PlacesUtils.POST_DATA_ANNO);
      this._write(" POST_DATA=\"" + this.escapeHtml(postData) + "\"");
    }

    if (PlacesUtils.annotations.itemHasAnnotation(aItem.itemId,
                                                  LOAD_IN_SIDEBAR_ANNO)) {
      this._write(" WEB_PANEL=\"true\"");
    }

    try {
      let lastCharset = yield PlacesUtils.getCharsetForURI(itemUri);
      if (lastCharset) {
        this._write(" LAST_CHARSET=\"" + this.escapeHtml(lastCharset) + "\"");
      }
    } catch(ex) { }

    this._writeLine(">" + this.escapeHtml(aItem.title) + "</A>");
    yield this._writeDescription(aItem);
  },

  _writeDateAttributes: function writeDateAttributes(aItem) {
    if (aItem.dateAdded) {
      this._write(" ADD_DATE=\"" +
                  Math.floor(aItem.dateAdded / MICROSEC_PER_SEC) + "\"");
    }
    if (aItem.lastModified) {
      this._write(" LAST_MODIFIED=\"" +
                  Math.floor(aItem.lastModified / MICROSEC_PER_SEC) + "\"");
    }
  },

  _writeFaviconAttribute: function writeFaviconAttribute(aItemUri) {
    let [faviconURI, dataLen, data] = yield this._promiseFaviconData(aItemUri);

    if (!faviconURI) {
      // Skip in case of errors.
      return;
    }

    this._write(" ICON_URI=\"" + this.escapeUrl(faviconURI.spec) + "\"");

    if (!faviconURI.schemeIs("chrome") && dataLen > 0) {
      let faviconContents = "data:image/png;base64," +
        base64EncodeString(String.fromCharCode.apply(String, data));
      this._write(" ICON=\"" + faviconContents + "\"");
    }
  },

  _promiseFaviconData: function(aPageURI) {
    var deferred = Promise.defer();
    PlacesUtils.favicons.getFaviconDataForPage(aPageURI,
      function (aURI, aDataLen, aData, aMimeType) {
        deferred.resolve([aURI, aDataLen, aData, aMimeType]);
      });
    return deferred.promise;
  },

  _writeDescription: function writeDescription(aItem) {
    if (PlacesUtils.annotations.itemHasAnnotation(aItem.itemId,
                                                  DESCRIPTION_ANNO)) {
      let description = PlacesUtils.annotations
                                   .getItemAnnotation(aItem.itemId,
                                                      DESCRIPTION_ANNO);
      // The description is not indented.
      this._writeLine("<DD>" + this.escapeHtml(description));
    }
  },

};
