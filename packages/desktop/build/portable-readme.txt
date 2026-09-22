This folder is where poptart keeps everything it writes.

Your songs, your settings, your samples and recordings, and the copy of SuperCollider poptart
downloads for itself on first run - all of it goes in here, beside poptart.exe, instead of in
your user folder. That is what makes this copy portable: the whole thing is one folder. Put it
on an external drive, move it between machines, back it up by copying it.

To update poptart, unpack the new zip over this folder. This folder is not in the zip's app
files, so it is left alone - your songs survive the update.

If you would rather poptart used your user folder (C:\Users\<you>\.poptart) like a normal
installed copy does, delete this folder. poptart only uses it if it is here.

One thing to know: do not copy this folder next to a poptart that you INSTALLED with
poptart-setup.exe. Uninstalling or updating an installed copy deletes its whole folder, and
would take your songs with it. poptart notices that case and ignores the folder rather than
filling it. To keep your files somewhere specific with an installed copy, set the POPTART_HOME
environment variable instead.
